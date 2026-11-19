//! A summary's rough time left (#72, Ben's request of 17 Nov; design note
//! `agent1-summary-progress-design`, v2): from the helper's own progress (`local_runner::Progress`)
//! and the speed this computer wrote its last summaries at, kept per model.
//!
//! What is kept, in `ai-speed.json` beside `vault-home` (never inside it, so no vault backup
//! holds it), per model SHA-256: the answer speed of the last finished summary (tokens a
//! second) and the answer lengths of the last [`KEPT_LENGTHS`] (tokens). Numbers only: no time,
//! no record, document or answer id, nothing about any letter. A cancelled or failed run is not
//! kept. A file that does not read as exactly that is not used, and is replaced by the next
//! finished summary's numbers.
//!
//! The estimate, in seconds, only ever goes down (the screen rounds it, and says "taking
//! longer" once the run passes it):
//! - reading, from the first batch read, and only with a kept speed: what is left to read at
//!   this run's own reading speed, the kept answer length at the kept answer speed, and
//!   [`CHECK_SECONDS`];
//! - writing, from the first sentence (also on a computer with nothing kept): the sentences
//!   left to the cap at this run's own seconds a sentence, and [`CHECK_SECONDS`], an upper
//!   bound since the model may stop before the cap;
//! - checking: none (milliseconds).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::local_runner::{Progress, Stage};
use crate::model_helper::Stats;

/// The app's own checks after the answer, rounded up generously (they take milliseconds).
const CHECK_SECONDS: f64 = 2.0;
/// The answer lengths kept per model: the estimate uses their median.
pub(crate) const KEPT_LENGTHS: usize = 5;
/// At most this many models are kept; the file stays small whatever happens.
const KEPT_MODELS: usize = 16;
/// Kept numbers outside these bounds are not believed (a damaged or foreign file).
const MAX_TOKENS_PER_SECOND: f64 = 10_000.0;

/// What is kept for one model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Kept {
    /// Answer tokens a second, the last finished summary's.
    pub(crate) answer_tokens_per_second: f64,
    /// The answer lengths of the last finished summaries, the latest last, in tokens.
    pub(crate) answer_tokens: Vec<u32>,
}

impl Kept {
    fn believable(&self) -> bool {
        self.answer_tokens_per_second.is_finite()
            && self.answer_tokens_per_second > 0.0
            && self.answer_tokens_per_second <= MAX_TOKENS_PER_SECOND
            && !self.answer_tokens.is_empty()
            && self.answer_tokens.len() <= KEPT_LENGTHS
            && self
                .answer_tokens
                .iter()
                .all(|&tokens| tokens > 0 && tokens as usize <= crate::model_helper::SUMMARY_TOKENS)
    }

    /// The seconds the kept speed writes the kept median answer in.
    fn writing_seconds(&self) -> f64 {
        let mut lengths = self.answer_tokens.clone();
        lengths.sort_unstable();
        let middle = lengths.len() / 2;
        let median = if lengths.len().is_multiple_of(2) {
            (f64::from(lengths[middle - 1]) + f64::from(lengths[middle])) / 2.0
        } else {
            f64::from(lengths[middle])
        };
        median / self.answer_tokens_per_second
    }
}

/// The kept speeds, by model SHA-256 (64 lowercase hex characters).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct Speeds(BTreeMap<String, Kept>);

fn is_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Speeds {
    /// The speeds in `text`, only when every entry is believable; otherwise none.
    pub(crate) fn read(text: &str) -> Option<Self> {
        let speeds: Self = serde_json::from_str(text).ok()?;
        (speeds.0.len() <= KEPT_MODELS
            && speeds
                .0
                .iter()
                .all(|(sha, kept)| is_sha256(sha) && kept.believable()))
        .then_some(speeds)
    }

    pub(crate) fn kept(&self, sha256: &str) -> Option<&Kept> {
        self.0.get(sha256)
    }

    /// Keeps a finished summary's speed for its model. `false` when `stats` do not give one.
    pub(crate) fn record(&mut self, sha256: &str, stats: &Stats) -> bool {
        if !is_sha256(sha256) || stats.answer_tokens == 0 || stats.answer_ms == 0 {
            return false;
        }
        let speed = f64::from(stats.answer_tokens) * 1000.0 / stats.answer_ms as f64;
        let mut lengths = self
            .0
            .get(sha256)
            .map(|kept| kept.answer_tokens.clone())
            .unwrap_or_default();
        lengths.push(stats.answer_tokens);
        let from = lengths.len().saturating_sub(KEPT_LENGTHS);
        let kept = Kept {
            answer_tokens_per_second: speed,
            answer_tokens: lengths.split_off(from),
        };
        if !kept.believable() {
            return false;
        }
        if !self.0.contains_key(sha256) && self.0.len() >= KEPT_MODELS {
            // Room for the model in use: another one goes (the first by SHA, which tells
            // nothing about when it was used).
            if let Some(first) = self.0.keys().next().cloned() {
                self.0.remove(&first);
            }
        }
        self.0.insert(sha256.to_owned(), kept);
        true
    }
}

/// Where the speeds are kept, set once at setup.
static FILE: OnceLock<PathBuf> = OnceLock::new();
/// One reader or writer at a time.
static LOCK: Mutex<()> = Mutex::new(());

/// Names the file (`ai-speed.json` in `dir`), once, at setup.
pub(crate) fn install(dir: &Path) {
    let _ = FILE.set(dir.join("ai-speed.json"));
}

fn load(path: &Path) -> Speeds {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| Speeds::read(&text))
        .unwrap_or_default()
}

/// What is kept for the model, if anything (none before setup).
pub(crate) fn kept(sha256: &str) -> Option<Kept> {
    let path = FILE.get()?;
    let _held = LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    load(path).kept(sha256).cloned()
}

/// Keeps a finished summary's speed. A file that cannot be written leaves the estimate
/// without it, nothing else.
pub(crate) fn record(sha256: &str, stats: &Stats) {
    let Some(path) = FILE.get() else {
        return;
    };
    let _held = LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let mut speeds = load(path);
    if !speeds.record(sha256, stats) {
        return;
    }
    let Ok(text) = serde_json::to_string(&speeds) else {
        return;
    };
    let _ = atomicwrites::AtomicFile::new(path, atomicwrites::AllowOverwrite).write(|file| {
        use std::io::Write;
        file.write_all(text.as_bytes())
    });
}

/// The time left of one summary, in whole seconds, that only ever goes down.
#[derive(Debug)]
pub(crate) struct Estimate {
    kept: Option<Kept>,
    /// When the request was written to the helper (the reading's start).
    started: Instant,
    /// When the last batch was read (the writing's start).
    read_at: Option<Instant>,
    /// The number last given: never a higher one after it.
    given: Option<u32>,
}

impl Estimate {
    pub(crate) fn new(kept: Option<Kept>, started: Instant) -> Self {
        Self {
            kept,
            started,
            read_at: None,
            given: None,
        }
    }

    /// The reading starts now (the request is written): this run's speeds count from here.
    pub(crate) fn start_at(&mut self, at: Instant) {
        self.started = at;
    }

    /// The seconds left after `progress`, at `now`, when there is a number to give.
    pub(crate) fn after(&mut self, progress: Progress, now: Instant) -> Option<u32> {
        let done = f64::from(progress.done);
        let left = f64::from(progress.total.saturating_sub(progress.done));
        let seconds = match progress.stage {
            Stage::Checking => return None,
            Stage::Reading => {
                if progress.done == progress.total {
                    self.read_at = Some(now);
                }
                let kept = self.kept.as_ref()?;
                let elapsed = now.saturating_duration_since(self.started).as_secs_f64();
                if progress.done == 0 || elapsed <= 0.0 {
                    return self.given;
                }
                left * elapsed / done + kept.writing_seconds() + CHECK_SECONDS
            }
            Stage::Writing => {
                let from = self.read_at.unwrap_or(self.started);
                let elapsed = now.saturating_duration_since(from).as_secs_f64();
                if progress.done == 0 || elapsed <= 0.0 {
                    return self.given;
                }
                left * elapsed / done + CHECK_SECONDS
            }
        };
        if !seconds.is_finite() || seconds < 0.0 {
            return self.given;
        }
        let seconds = seconds.ceil().min(f64::from(u32::MAX)) as u32;
        let given = self.given.map_or(seconds, |was| was.min(seconds));
        self.given = Some(given);
        Some(given)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const SHA: &str = "13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983";

    fn stats(answer_tokens: u32, answer_ms: u64) -> Stats {
        Stats {
            answer_tokens,
            answer_ms,
            ..Stats::default()
        }
    }

    fn reading(done: u32, total: u32) -> Progress {
        Progress {
            stage: Stage::Reading,
            done,
            total,
        }
    }

    fn writing(done: u32, total: u32) -> Progress {
        Progress {
            stage: Stage::Writing,
            done,
            total,
        }
    }

    fn kept(speed: f64, lengths: &[u32]) -> Kept {
        Kept {
            answer_tokens_per_second: speed,
            answer_tokens: lengths.to_vec(),
        }
    }

    #[test]
    fn a_finished_summary_keeps_its_speed_and_the_last_five_lengths_only() {
        let mut speeds = Speeds::default();
        for tokens in [100, 200, 300, 400, 500, 600] {
            assert!(speeds.record(SHA, &stats(tokens, 20_000)));
        }
        let kept = speeds.kept(SHA).unwrap();
        assert_eq!(kept.answer_tokens, [200, 300, 400, 500, 600]);
        assert_eq!(kept.answer_tokens_per_second, 30.0);
        // Median 400 tokens at 30 a second.
        assert!((kept.writing_seconds() - 400.0 / 30.0).abs() < 1e-9);
        // Nothing to keep from an answer without tokens or time, or for a name that is no SHA.
        assert!(!speeds.record(SHA, &stats(0, 1000)));
        assert!(!speeds.record(SHA, &stats(10, 0)));
        assert!(!speeds.record("FAKE", &stats(10, 1000)));
        assert_eq!(speeds.kept(SHA).unwrap().answer_tokens.len(), 5);
    }

    #[test]
    fn the_kept_file_holds_numbers_by_model_only_and_a_wrong_one_is_not_used() {
        let mut speeds = Speeds::default();
        speeds.record(SHA, &stats(450, 86_538));
        let text = serde_json::to_string(&speeds).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value.as_object().unwrap().keys().collect::<Vec<_>>(), [SHA]);
        let entry = value[SHA].as_object().unwrap();
        assert_eq!(
            entry.keys().collect::<Vec<_>>(),
            ["answerTokens", "answerTokensPerSecond"]
        );
        assert!(entry["answerTokensPerSecond"].is_number());
        assert!(entry["answerTokens"]
            .as_array()
            .unwrap()
            .iter()
            .all(serde_json::Value::is_u64));
        assert_eq!(Speeds::read(&text), Some(speeds));
        // Not used: another key, a name that is no SHA, a speed or a length out of bounds,
        // too many lengths, or not JSON.
        for wrong in [
            format!(r#"{{"{SHA}":{{"answerTokensPerSecond":5.0,"answerTokens":[450],"x":1}}}}"#),
            r#"{"FAKE":{"answerTokensPerSecond":5.0,"answerTokens":[450]}}"#.to_owned(),
            format!(r#"{{"{SHA}":{{"answerTokensPerSecond":0.0,"answerTokens":[450]}}}}"#),
            format!(r#"{{"{SHA}":{{"answerTokensPerSecond":5.0,"answerTokens":[]}}}}"#),
            format!(r#"{{"{SHA}":{{"answerTokensPerSecond":5.0,"answerTokens":[99999]}}}}"#),
            format!(r#"{{"{SHA}":{{"answerTokensPerSecond":5.0,"answerTokens":[1,2,3,4,5,6]}}}}"#),
            "not JSON".to_owned(),
        ] {
            assert_eq!(Speeds::read(&wrong), None, "{wrong}");
        }
    }

    #[test]
    fn at_most_sixteen_models_are_kept() {
        let mut speeds = Speeds::default();
        for n in 0..20u32 {
            let sha = format!("{n:064x}");
            assert!(speeds.record(&sha, &stats(100, 10_000)));
            assert!(speeds.kept(&sha).is_some());
        }
        assert_eq!(speeds.0.len(), KEPT_MODELS);
    }

    #[test]
    fn reading_gives_no_number_without_a_kept_speed_and_writing_gives_one_from_its_first_sentence()
    {
        let start = Instant::now();
        let at = |seconds: u64| start + Duration::from_secs(seconds);
        let mut estimate = Estimate::new(None, start);
        assert_eq!(estimate.after(reading(512, 1148), at(27)), None);
        assert_eq!(estimate.after(reading(1148, 1148), at(60)), None);
        // 1 sentence of 10 in 12 s: 9 more at 12 s each, and the checks.
        assert_eq!(estimate.after(writing(1, 10), at(72)), Some(9 * 12 + 2));
        // The checks give none.
        assert_eq!(
            estimate.after(
                Progress {
                    stage: Stage::Checking,
                    done: 1,
                    total: 1
                },
                at(175)
            ),
            None
        );
    }

    #[test]
    fn the_typical_letter_of_the_design_note_reads_about_two_minutes_after_its_first_batch() {
        // Design note, section 3: 1,148 tokens to read; after the first 512 in 27 s, 636 left
        // at 19 a second (33 s), the kept 450 tokens at 5.2 a second (87 s), and 2 s.
        let start = Instant::now();
        let mut estimate = Estimate::new(Some(kept(5.2, &[450])), start);
        let given = estimate
            .after(reading(512, 1148), start + Duration::from_secs(27))
            .unwrap();
        let expected: f64 = 636.0 * 27.0 / 512.0 + 450.0 / 5.2 + 2.0;
        assert_eq!(given, expected.ceil() as u32);
        assert!((120..=125).contains(&given), "{given}");
    }

    #[test]
    fn the_number_never_goes_up_and_the_clock_starts_when_the_request_is_written() {
        let start = Instant::now();
        let at = |seconds: u64| start + Duration::from_secs(seconds);
        let mut estimate = Estimate::new(Some(kept(5.0, &[100])), start);
        // The helper took 30 s to start: the reading's own speed counts from the request.
        estimate.start_at(at(30));
        let first = estimate.after(reading(500, 1000), at(40)).unwrap();
        assert_eq!(first, 10 + 20 + 2);
        // Slower now (400 left at 12 a second, 55 s in all): the number stays.
        assert_eq!(estimate.after(reading(600, 1000), at(80)), Some(first));
        // All read: the kept writing and the checks, 22 s.
        assert_eq!(estimate.after(reading(1000, 1000), at(100)), Some(22));
        // Writing slowly (9 more at 60 s each): still 22, never more.
        assert_eq!(estimate.after(writing(1, 10), at(160)), Some(22));
        // Faster than thought: it goes down.
        let later = estimate.after(writing(9, 10), at(170)).unwrap();
        assert_eq!(later, (70.0f64 / 9.0 + 2.0).ceil() as u32);
        assert!(later < 22);
    }
}

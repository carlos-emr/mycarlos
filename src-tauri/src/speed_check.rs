//! The speed check (#305 PR 4): how fast the AI helper reads and writes on this computer, measured
//! once by the patient's own request and kept per model, helper build and thread count.
//!
//! The check is one real, short, fixed request through the normal runner: an explanation of a
//! made-up term in a made-up sentence (FAKE text, nothing of the patient's). The helper already
//! reports counts and times for every answer (`model_helper::Stats`), so nothing new crosses the
//! helper's boundary; the app turns them into two rates. It takes the runner's one-answer-at-a-time
//! slot and the unlocked session's hold like any answer, so it cannot run while locked or beside
//! another answer, and a lock or a cancel stops it.
//!
//! What the numbers are used for: an honest "about N minutes" before a long summary (display
//! only; no time limit changes here). They are kept in a small device file beside the models,
//! read as untrusted (size, shape, ranges, regular file), and a missing or bad file is no
//! measurement: the reader then says nothing about time.

use serde::{Deserialize, Serialize};

use crate::model_helper::Stats;
use crate::model_runtime::ExplainRequest;

/// The file's name, beside the models folder.
pub(crate) const SPEED_FILE: &str = "model-speed-v1.json";
/// The most a speed file may hold: 32 entries are about 4 KiB.
pub(crate) const MAX_SPEED_FILE_BYTES: usize = 32 * 1024;
/// The most entries (one per model, helper build and thread count).
pub(crate) const MAX_STORED_SPEEDS: usize = 32;
/// A measurement needs a prompt and an answer long enough to time.
pub(crate) const MIN_PROMPT_TOKENS: u32 = 50;
pub(crate) const MIN_ANSWER_TOKENS: u32 = 10;
/// Rates in thousandths of a token a second: 0.01 to 5,000.
pub(crate) const MILLI_TPS: std::ops::RangeInclusive<u32> = 10..=5_000_000;
const MAX_HELPER_BUILD_CHARS: usize = 64;

/// How fast the helper read the prompt and wrote the answer, in thousandths of a token a second.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Speed {
    pub(crate) prompt_milli_tps: u32,
    pub(crate) answer_milli_tps: u32,
}

impl Speed {
    fn in_range(&self) -> bool {
        MILLI_TPS.contains(&self.prompt_milli_tps) && MILLI_TPS.contains(&self.answer_milli_tps)
    }
}

/// The two rates one answer's counts and times give, or none when it was too short to tell (a
/// prompt under [`MIN_PROMPT_TOKENS`] or an answer under [`MIN_ANSWER_TOKENS`], a time of zero, or
/// a rate out of range): the check then says it could not measure, and keeps nothing.
pub(crate) fn measure(stats: &Stats) -> Option<Speed> {
    if stats.prompt_tokens < MIN_PROMPT_TOKENS
        || stats.answer_tokens < MIN_ANSWER_TOKENS
        || stats.prompt_ms == 0
        || stats.answer_ms == 0
    {
        return None;
    }
    let milli = |tokens: u32, ms: u64| {
        u32::try_from(u64::from(tokens).saturating_mul(1_000_000) / ms).unwrap_or(u32::MAX)
    };
    let speed = Speed {
        prompt_milli_tps: milli(stats.prompt_tokens, stats.prompt_ms),
        answer_milli_tps: milli(stats.answer_tokens, stats.answer_ms),
    };
    speed.in_range().then_some(speed)
}

/// The fixed FAKE request: a made-up term in a made-up sentence, about 300 tokens of prompt and an
/// answer of up to the helper's explain limit.
pub(crate) fn check_request() -> ExplainRequest {
    ExplainRequest {
        term: "FAKE ejection fraction".to_owned(),
        context: "FAKE sample text for timing only, about nobody. A made-up report says the \
            heart pumped out 35 percent of its blood with each beat, which is lower than the \
            usual range, and that the result was the same as the one made up for the year \
            before. The same made-up report says the made-up patient felt tired when walking up \
            stairs, had no chest pain, and was asked to come back in three months for another \
            made-up test, with a made-up list of medicines to keep taking in the meantime. None \
            of this is real. It exists only so that the helper has a sentence to read and a \
            few sentences to write while it is timed."
            .to_owned(),
        lang: "en".to_owned(),
        record_id: None,
    }
}

/// One measurement, for one model file (its SHA-256), one helper build and one thread count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredSpeed {
    pub(crate) sha256: String,
    pub(crate) helper_build: String,
    pub(crate) threads: u32,
    pub(crate) speed: Speed,
    pub(crate) at_ms: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SpeedFile {
    v: u32,
    entries: Vec<StoredSpeed>,
}

fn valid_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_build(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= MAX_HELPER_BUILD_CHARS
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-' | b'_' | b'/'))
}

/// The entries of a speed file that are all in range, or none: a file that is too large, not JSON
/// of exactly this shape, of another version or with too many entries is refused whole; within a good
/// file an entry with a bad hash, build, thread count or rate is dropped on its own. A repeated
/// model, build and thread count keeps the last.
pub(crate) fn parse_speed_file(bytes: &[u8]) -> Vec<StoredSpeed> {
    if bytes.len() > MAX_SPEED_FILE_BYTES {
        return Vec::new();
    }
    let Ok(file) = serde_json::from_slice::<SpeedFile>(bytes) else {
        return Vec::new();
    };
    if file.v != 1 || file.entries.len() > MAX_STORED_SPEEDS {
        return Vec::new();
    }
    let mut kept: Vec<StoredSpeed> = Vec::new();
    for entry in file.entries {
        if !valid_sha256(&entry.sha256)
            || !valid_build(&entry.helper_build)
            || !(1..=64).contains(&entry.threads)
            || !entry.speed.in_range()
        {
            continue;
        }
        kept.retain(|other| {
            !(other.sha256 == entry.sha256
                && other.helper_build == entry.helper_build
                && other.threads == entry.threads)
        });
        kept.push(entry);
    }
    kept
}

/// The file's bytes for `entries` (the newest [`MAX_STORED_SPEEDS`]), or none if too large.
pub(crate) fn speed_file_bytes(entries: &[StoredSpeed]) -> Option<Vec<u8>> {
    let from = entries.len().saturating_sub(MAX_STORED_SPEEDS);
    let bytes = serde_json::to_vec(&SpeedFile {
        v: 1,
        entries: entries[from..].to_vec(),
    })
    .ok()?;
    (bytes.len() <= MAX_SPEED_FILE_BYTES).then_some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA_A: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn stats(prompt_tokens: u32, prompt_ms: u64, answer_tokens: u32, answer_ms: u64) -> Stats {
        Stats {
            prompt_tokens,
            prompt_ms,
            answer_tokens,
            answer_ms,
            ..Stats::default()
        }
    }

    fn stored(sha: &str, threads: u32) -> StoredSpeed {
        StoredSpeed {
            sha256: sha.to_owned(),
            helper_build: "1.0.0+mycarlos-model/1".to_owned(),
            threads,
            speed: Speed {
                prompt_milli_tps: 9_000,
                answer_milli_tps: 2_500,
            },
            at_ms: 1_000,
        }
    }

    #[test]
    fn the_counts_and_times_become_two_rates() {
        // 300 tokens in 30 s is 10 a second; 60 tokens in 24 s is 2.5 a second.
        assert_eq!(
            measure(&stats(300, 30_000, 60, 24_000)),
            Some(Speed {
                prompt_milli_tps: 10_000,
                answer_milli_tps: 2_500,
            })
        );
    }

    #[test]
    fn an_answer_too_short_or_untimed_is_no_measurement() {
        for bad in [
            stats(49, 5_000, 60, 24_000),
            stats(300, 30_000, 9, 3_000),
            stats(300, 0, 60, 24_000),
            stats(300, 30_000, 60, 0),
            // A rate under 0.01 a second or over 5,000 is not one the helper makes.
            stats(300, 4_000_000_000, 60, 24_000),
            stats(u32::MAX, 1, 60, 24_000),
        ] {
            assert_eq!(measure(&bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_fixed_request_is_fake_text_the_helper_accepts() {
        let request = check_request();
        assert!(request.term.starts_with("FAKE"));
        assert!(request.context.starts_with("FAKE"));
        assert!(crate::model_runtime::check_explain(&request).is_ok());
        assert_eq!(request.record_id, None);
    }

    #[test]
    fn a_saved_file_comes_back_and_a_repeat_keeps_the_last() {
        let mut newer = stored(SHA_A, 2);
        newer.speed.answer_milli_tps = 1_000;
        let entries = vec![stored(SHA_A, 2), stored(SHA_A, 3), newer.clone()];
        let bytes = speed_file_bytes(&entries).unwrap();
        assert_eq!(parse_speed_file(&bytes), vec![stored(SHA_A, 3), newer]);
    }

    #[test]
    fn a_missing_oversized_or_malformed_file_is_no_file() {
        assert!(parse_speed_file(b"").is_empty());
        assert!(parse_speed_file(b"nope").is_empty());
        assert!(parse_speed_file(&vec![b' '; MAX_SPEED_FILE_BYTES + 1]).is_empty());
        for bad in [
            r#"{"v":2,"entries":[]}"#,
            r#"{"v":1}"#,
            r#"{"v":1,"entries":[],"x":1}"#,
            "[]",
        ] {
            assert!(parse_speed_file(bad.as_bytes()).is_empty(), "{bad}");
        }
        let too_many: Vec<StoredSpeed> = (0..=MAX_STORED_SPEEDS)
            .map(|n| stored(&format!("{n:064x}"), 2))
            .collect();
        let bytes = serde_json::to_vec(&SpeedFile {
            v: 1,
            entries: too_many,
        })
        .unwrap();
        assert!(parse_speed_file(&bytes).is_empty());
    }

    #[test]
    fn a_bad_entry_is_dropped_on_its_own() {
        let mut out_of_range = stored(SHA_A, 2);
        out_of_range.speed.prompt_milli_tps = 9;
        let mut bad_threads = stored(SHA_A, 0);
        bad_threads.threads = 65;
        let mut bad_build = stored(SHA_A, 2);
        bad_build.helper_build = "bad build!".to_owned();
        let good = stored(SHA_A, 4);
        let entries = vec![
            out_of_range,
            bad_threads,
            bad_build,
            stored("NOT-A-HASH", 2),
            good.clone(),
        ];
        let bytes = serde_json::to_vec(&SpeedFile { v: 1, entries }).unwrap();
        assert_eq!(parse_speed_file(&bytes), vec![good]);
    }
}

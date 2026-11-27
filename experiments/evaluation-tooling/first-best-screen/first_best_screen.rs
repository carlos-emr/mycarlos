//! Component-only screen: synthetic logits, no llama/native/model dependencies.
use std::hint::black_box;
use std::time::{Duration, Instant};

// Standalone mirror of the pinned llama-cpp-2 transparent i32 token and constructor.
// It is not a link to the original library, so cross-crate/layout effects are unmeasured.
#[repr(transparent)]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
struct LlamaToken(i32);
impl LlamaToken {
    #[must_use]
    pub fn new(token_id: i32) -> Self {
        Self(token_id)
    }
}

// BEGIN EXACT6595 first_best
fn first_best(scores: impl Iterator<Item = (LlamaToken, f32)>) -> Option<(LlamaToken, f32)> {
    let mut best: Option<(LlamaToken, f32)> = None;
    for (token, score) in scores {
        if best.is_none_or(|(_, top)| score > top) {
            best = Some((token, score));
        }
    }
    best
}
// END EXACT6595 first_best

fn rank(logits: &[f32]) -> Option<(LlamaToken, f32)> {
    first_best(
        // BEGIN EXACT6595 primary iterator
        logits
                .iter()
                .enumerate()
                .map(|(id, score)| (LlamaToken::new(id as i32), *score)),
        // END EXACT6595 primary iterator
    )
}

fn semantic_checks() {
    assert_eq!(rank(&[]), None);
    assert_eq!(rank(&[2.0, 2.0, 1.0]), Some((LlamaToken::new(0), 2.0)));
    assert_eq!(rank(&[-3.0, 4.0, 2.0]), Some((LlamaToken::new(1), 4.0)));
    let first_nan = rank(&[f32::NAN, 9.0]).unwrap();
    assert_eq!(first_nan.0, LlamaToken::new(0));
    assert!(first_nan.1.is_nan());
    assert_eq!(rank(&[1.0, f32::NAN, 2.0]), Some((LlamaToken::new(2), 2.0)));
    assert_eq!(rank(&[f32::INFINITY, f32::INFINITY]), Some((LlamaToken::new(0), f32::INFINITY)));
}

fn synthetic_logits(len: usize) -> Vec<f32> {
    let mut state: u32 = 0x9e3779b9 ^ (len as u32);
    let mut values = Vec::with_capacity(len);
    for _ in 0..len {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        values.push(((state >> 8) as f32 / 16777216.0) - 0.5);
    }
    // Two equal maxima exercise first-on-tie behavior with known expected output.
    values[len / 3] = 2.0;
    values[2 * len / 3] = 2.0;
    values
}

fn main() {
    semantic_checks();
    for size in [131072usize, 262144usize, 524288usize] {
        let logits = synthetic_logits(size);
        let expected = Some((LlamaToken::new((size / 3) as i32), 2.0));
        assert_eq!(rank(black_box(logits.as_slice())), expected);
        // Warm allocation/code paths only. These are repeated warm synthetic scans.
        for _ in 0..4 { black_box(rank(black_box(logits.as_slice()))); }
        let started = Instant::now();
        let span = Duration::from_millis(150);
        let mut calls = 0u64;
        let mut checksum = 0u64;
        let mut last = None;
        while started.elapsed() < span {
            // Amortize clock reads. Both input slice and result are opaque to optimization.
            for _ in 0..8 {
                last = black_box(rank(black_box(logits.as_slice())));
                let (token, score) = last.unwrap();
                checksum = checksum.wrapping_add(token.0 as u64).wrapping_add(score.to_bits() as u64);
                calls += 1;
            }
        }
        let elapsed_ns = started.elapsed().as_nanos();
        assert!(calls > 0);
        assert_eq!(last, expected);
        black_box(checksum);
        println!("{{\"schema\":\"first-best-component-screen-v1\",\"synthetic_logits\":{},\"calls\":{},\"elapsed_ns\":{},\"ns_per_call\":{:.3},\"result_token\":{},\"result_score_bits\":{},\"checksum\":{},\"warm_repeated_input\":true,\"model_vocab_size_claimed\":false}}",
            size, calls, elapsed_ns, elapsed_ns as f64 / calls as f64,
            (size / 3), 2.0f32.to_bits(), checksum);
    }
}

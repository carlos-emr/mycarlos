//! Production verifier tests against an independent, one-token greedy grammar oracle.
//! No native/model work is performed by this module. Pure keep_end validation cannot prove
//! native seq_rm succeeds: the adapter must check Ok(true), check seq_pos_max and consume
//! its deferred recurrent rollback exactly once before another removal. Those behaviors need
//! separate adapter/native qualification; these tests make no such claim.

use super::{candidate_count, keep_end, verify_prefix, TargetOracle};

const OPEN: u8 = 0;
const CLOSE: u8 = 1;
const WORD: u8 = 2;
const EOG: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Grammar {
    Before,
    Inside,
    Done,
}

impl Grammar {
    fn allows(self, token: u8) -> bool {
        match self {
            Self::Before => token == OPEN,
            Self::Inside => token == CLOSE || token == WORD,
            Self::Done => token == EOG,
        }
    }

    fn emit(&mut self, token: u8) {
        assert!(self.allows(token));
        assert_ne!(token, EOG, "EOG must never advance emitted grammar state");
        *self = match token {
            OPEN => Self::Inside,
            CLOSE => Self::Done,
            _ => *self,
        };
    }
}

/// Independent exhaustive four-token ranking: grammar filter first, then score descending,
/// then id ascending. It does not inspect the draft or use production verification helpers.
fn reference_pick(grammar: Grammar, logits: &[f32; 4]) -> Option<u8> {
    let mut allowed: Vec<_> = logits
        .iter()
        .copied()
        .enumerate()
        .filter(|(id, score)| grammar.allows(*id as u8) && score.is_finite())
        .collect();
    allowed.sort_by(|(left_id, left), (right_id, right)| {
        right
            .partial_cmp(left)
            .expect("finite fixture scores")
            .then(left_id.cmp(right_id))
    });
    let token = allowed
        .first()
        .expect("fixture has a finite allowed token")
        .0 as u8;
    (token != EOG).then_some(token)
}

struct Oracle<'a> {
    rows: &'a [[f32; 4]],
    grammar: Grammar,
    picks: Vec<usize>,
    commits: Vec<u8>,
}

impl<'a> Oracle<'a> {
    fn new(rows: &'a [[f32; 4]], grammar: Grammar) -> Self {
        Self {
            rows,
            grammar,
            picks: Vec::new(),
            commits: Vec::new(),
        }
    }
}

impl TargetOracle for Oracle<'_> {
    type Token = u8;
    type Error = &'static str;

    fn pick(&mut self, row: usize) -> Result<Option<u8>, Self::Error> {
        self.picks.push(row);
        self.rows
            .get(row)
            .map(|logits| reference_pick(self.grammar, logits))
            .ok_or("missing target row")
    }

    fn commit(&mut self, token: u8) {
        self.grammar.emit(token);
        self.commits.push(token);
    }
}

/// Generate a finite reference trace one token at a time, without looking at proposals.
/// Teacher-forced rows after a mismatch are irrelevant: only the first differing token of
/// this trace is compared with production, never a claimed continuation after divergence.
fn reference_trace(rows: &[[f32; 4]], initial: Grammar, room: usize) -> (Vec<u8>, bool) {
    let mut grammar = initial;
    let mut generated = Vec::new();
    for logits in rows.iter().take(room) {
        let Some(token) = reference_pick(grammar, logits) else {
            return (generated, true);
        };
        grammar.emit(token);
        generated.push(token);
    }
    (generated, false)
}

#[test]
fn target_eog_never_commits_a_token_or_advances_grammar() {
    let mut oracle = Oracle::new(&[[9., 8., 7., 0.]], Grammar::Done);
    let out = verify_prefix(&[WORD], 8, &mut oracle).unwrap();
    assert_eq!(out.accepted, 0);
    assert!(out.eog && !out.capped && out.next.is_none());
    assert_eq!(oracle.picks, [0]);
    assert!(oracle.commits.is_empty());
    assert_eq!(oracle.grammar, Grammar::Done);
}

#[test]
fn first_rejection_uses_grammar_allowed_choice_and_never_reads_later_rows() {
    // OPEN100 is forbidden inside; allowed WORD3 beats CLOSE2.
    let mut oracle = Oracle::new(&[[100., 2., 3., -1.]], Grammar::Inside);
    let out = verify_prefix(&[CLOSE, OPEN], 8, &mut oracle).unwrap();
    assert_eq!((out.accepted, out.next), (0, Some(WORD)));
    assert!(!out.eog && !out.capped);
    assert_eq!(oracle.picks, [0]);
    assert!(oracle.commits.is_empty());
    assert_eq!(oracle.grammar, Grammar::Inside);
    assert_eq!(keep_end(10, 2, out.accepted, 8192, 2), Some(11));
}

#[test]
fn accepted_close_advances_grammar_before_bonus_eog_choice() {
    let mut oracle = Oracle::new(&[[0., 4., 1., 9.], [8., 9., 10., 0.]], Grammar::Inside);
    let out = verify_prefix(&[CLOSE], 8, &mut oracle).unwrap();
    assert_eq!(out.accepted, 1);
    assert!(out.eog && !out.capped && out.next.is_none());
    assert_eq!(oracle.commits, [CLOSE]);
    assert_eq!(oracle.grammar, Grammar::Done);
    assert_eq!(oracle.picks, [0, 1]);
}

#[test]
fn partial_acceptance_does_not_commit_mismatch_or_read_invalid_suffix() {
    let mut oracle = Oracle::new(&[[0., 1., 2., 0.], [0., 4., 1., 0.]], Grammar::Inside);
    let out = verify_prefix(&[WORD, WORD, OPEN], 8, &mut oracle).unwrap();
    assert_eq!((out.accepted, out.next), (1, Some(CLOSE)));
    assert_eq!(oracle.commits, [WORD]);
    assert_eq!(oracle.grammar, Grammar::Inside);
    assert_eq!(oracle.picks, [0, 1]);
    let end = keep_end(20, 3, out.accepted, 8192, 3).unwrap() as usize;
    assert_eq!(end, 22);
    assert_eq!(
        20 + 3 + 1 - end,
        2,
        "two unaccepted cache inputs are removed"
    );
}

#[test]
fn equal_allowed_logits_select_lower_id_without_committing_other_draft() {
    let mut oracle = Oracle::new(&[[100., 2., 2., -1.]], Grammar::Inside);
    let out = verify_prefix(&[WORD], 1, &mut oracle).unwrap();
    assert_eq!((out.accepted, out.next), (0, Some(CLOSE)));
    assert!(oracle.commits.is_empty());
}

#[test]
fn eog_and_suffix_are_clipped_before_the_production_verifier() {
    let draft = [WORD, EOG, CLOSE];
    assert_eq!(candidate_count(&draft, 9, |token| *token == EOG), 1);
    assert_eq!(candidate_count(&draft, 0, |token| *token == EOG), 0);
    assert_eq!(
        candidate_count(&[EOG, WORD], usize::MAX, |token| *token == EOG),
        0
    );
    let submitted = &draft[..candidate_count(&draft, 9, |token| *token == EOG)];
    let mut oracle = Oracle::new(&[[0., 1., 2., 0.], [0., 4., 1., 0.]], Grammar::Inside);
    let out = verify_prefix(submitted, 9, &mut oracle).unwrap();
    assert_eq!(oracle.commits, [WORD]);
    assert_eq!(out.next, Some(CLOSE));
    assert!(!submitted.contains(&EOG));
}

#[test]
fn zero_remaining_room_has_no_pick_or_commit_or_bonus() {
    let mut oracle = Oracle::new(&[], Grammar::Inside);
    let out = verify_prefix(&[WORD], 0, &mut oracle).unwrap();
    assert!(out.capped && !out.eog && out.next.is_none());
    assert_eq!(out.accepted, 0);
    assert!(oracle.picks.is_empty() && oracle.commits.is_empty());
    // The adapter must have decoded the already-emitted final pending token once.
    // This pure verifier cannot establish that native decode side effect.
    assert_eq!(keep_end(4, 0, 0, 8192, 1), Some(5));
}

#[test]
fn accepted_final_token_at_cap_needs_no_bonus_row() {
    let mut oracle = Oracle::new(&[[0., 1., 2., 0.]], Grammar::Inside);
    let out = verify_prefix(&[WORD], 1, &mut oracle).unwrap();
    assert_eq!(out.accepted, 1);
    assert!(out.capped && !out.eog && out.next.is_none());
    assert_eq!(oracle.picks, [0]);
    assert_eq!(oracle.commits, [WORD]);
}

#[test]
fn target_oracle_failure_propagates_without_committing_the_unverified_suffix() {
    let mut oracle = Oracle::new(&[[0., 1., 2., 0.]], Grammar::Inside);
    assert_eq!(
        verify_prefix(&[WORD, CLOSE], 5, &mut oracle),
        Err("missing target row")
    );
    assert_eq!(oracle.picks, [0, 1]);
    assert_eq!(oracle.commits, [WORD]);
    // Already accumulated output is tentative; the request adapter must discard it on Err.
}

#[test]
fn production_verification_matches_independent_sequential_oracle_across_fixtures() {
    let patterns = [
        [0., 1., 2., 3.],
        [100., 2., 2., 0.],
        [0., 8., 1., 0.],
        [0., 1., 9., 0.],
    ];
    let drafts: &[&[u8]] = &[
        &[],
        &[OPEN],
        &[CLOSE],
        &[WORD],
        &[WORD, CLOSE],
        &[CLOSE, WORD],
        &[WORD, WORD, CLOSE],
    ];
    for initial in [Grammar::Before, Grammar::Inside, Grammar::Done] {
        for rotation in 0..patterns.len() {
            let rows: Vec<_> = (0..6)
                .map(|row| patterns[(row + rotation) % patterns.len()])
                .collect();
            for draft in drafts {
                for room in 0..=4 {
                    let (reference, reference_eog) = reference_trace(&rows, initial, room);
                    let prefix = draft
                        .iter()
                        .zip(&reference)
                        .take_while(|(left, right)| left == right)
                        .count();
                    let mut oracle = Oracle::new(&rows, initial);
                    let actual = verify_prefix(draft, room, &mut oracle).unwrap();
                    assert_eq!(actual.accepted, prefix);
                    assert_eq!(oracle.commits, draft[..prefix]);
                    let mut expected_grammar = initial;
                    for token in &draft[..prefix] {
                        expected_grammar.emit(*token);
                    }
                    assert_eq!(oracle.grammar, expected_grammar);
                    if prefix == room {
                        assert!(actual.capped && !actual.eog && actual.next.is_none());
                        assert_eq!(oracle.picks.len(), prefix);
                    } else if let Some(next) = reference.get(prefix) {
                        assert_eq!(actual.next, Some(*next));
                        assert!(!actual.eog && !actual.capped);
                        assert_eq!(oracle.picks.len(), prefix + 1);
                    } else {
                        assert!(reference_eog && actual.eog && !actual.capped);
                        assert!(actual.next.is_none());
                        assert_eq!(oracle.picks.len(), prefix + 1);
                    }
                }
            }
        }
    }
}

#[test]
fn accepted_boundary_removes_only_rejected_inputs_within_snapshot_capacity() {
    for position in [1, 3, 512, 8188] {
        for capacity in 0..=3 {
            for submitted in 0..=capacity {
                for accepted in 0..=submitted {
                    let end =
                        keep_end(position, submitted, accepted, 8192, capacity).unwrap() as usize;
                    assert_eq!(end, position + accepted + 1);
                    assert_eq!(position + submitted + 1 - end, submitted - accepted);
                    assert!(submitted - accepted <= capacity);
                }
            }
        }
    }
}

#[test]
fn invalid_snapshot_depth_and_entire_submitted_batch_bounds_fail_closed() {
    for args in [
        (0, 1, 0, 8192, 1),
        (8, 2, 0, 8192, 1),
        (8, 1, 2, 8192, 1),
        (usize::MAX, 1, 0, usize::MAX, 1),
        (u32::MAX as usize, 0, 0, usize::MAX, 0),
        (8191, 1, 0, 8192, 1), // accepted boundary fits, but the rejected input would not.
        (8192, 0, 0, 8192, 0),
    ] {
        assert_eq!(keep_end(args.0, args.1, args.2, args.3, args.4), None);
    }
    assert_eq!(keep_end(8190, 1, 0, 8192, 1), Some(8191));
    assert_eq!(keep_end(8190, 1, 1, 8192, 1), Some(8192));
}

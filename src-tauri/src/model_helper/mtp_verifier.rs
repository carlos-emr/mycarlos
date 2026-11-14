//! Greedy target verification only. Draft tokens never advance the grammar by themselves.

#[cfg(test)]
#[path = "mtp_verifier_tests.rs"]
mod tests;

/// `pick` observes the current grammar; only `commit` advances it and emits a token.
/// `None` means target EOG, which must never be committed or submitted to target decode.
pub(super) trait TargetOracle {
    type Token: Copy + Eq;
    type Error;

    fn pick(&mut self, row: usize) -> Result<Option<Self::Token>, Self::Error>;
    fn commit(&mut self, token: Self::Token);
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Verified<T> {
    pub accepted: usize,
    pub next: Option<T>,
    pub eog: bool,
    pub capped: bool,
}

/// Rows predict the token after the pending input and then each submitted proposal.
/// Stop at the first mismatch/EOG. An accepted final token needs no bonus pick.
pub(super) fn verify_prefix<O: TargetOracle>(
    submitted: &[O::Token],
    room: usize,
    oracle: &mut O,
) -> Result<Verified<O::Token>, O::Error> {
    let mut accepted = 0;
    loop {
        if accepted == room {
            return Ok(Verified {
                accepted,
                next: None,
                eog: false,
                capped: true,
            });
        }
        let Some(selected) = oracle.pick(accepted)? else {
            return Ok(Verified {
                accepted,
                next: None,
                eog: true,
                capped: false,
            });
        };
        if submitted.get(accepted) != Some(&selected) {
            return Ok(Verified {
                accepted,
                next: Some(selected),
                eog: false,
                capped: false,
            });
        }
        oracle.commit(selected);
        accepted += 1;
    }
}

/// Only the non-EOG prefix fitting the remaining answer budget can be target input.
pub(super) fn candidate_count<T>(draft: &[T], room: usize, is_eog: impl Fn(&T) -> bool) -> usize {
    draft
        .iter()
        .take(room)
        .take_while(|token| !is_eog(token))
        .count()
}

/// Half-open cache boundary after the pending token plus accepted proposals. The whole
/// verification batch must fit, even when its rejected suffix is about to be removed.
pub(super) fn keep_end(
    position: usize,
    submitted: usize,
    accepted: usize,
    context_tokens: usize,
    rollback_capacity: usize,
) -> Option<u32> {
    if position == 0 || submitted > rollback_capacity || accepted > submitted {
        return None;
    }
    let decoded_end = position.checked_add(submitted)?.checked_add(1)?;
    if decoded_end > context_tokens {
        return None;
    }
    u32::try_from(position.checked_add(accepted)?.checked_add(1)?).ok()
}

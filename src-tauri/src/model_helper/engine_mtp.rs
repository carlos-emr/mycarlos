//! Default-OFF same-model MTP experiment, pinned to the current Qwen3.5-4B layout.
//! Each request owns new contexts AND a new native speculative driver. `begin()` alone
//! does not clear native pending_h/verify_h. No prefix state is reused on this path.

use super::{
    answer_hash, context_params, failed, Engine, Failure, LlamaBatch, LlamaContext, LlamaModel,
    LlamaSampler, LlamaToken, Stats, ANSWER_HASH_START, BATCH_TOKENS, CONTEXT_TOKENS,
};
use crate::model_helper::ExperimentalMtpStats;
use llama_cpp_2::context::params::LlamaContextType;
use llama_cpp_2::speculative::{MtpSpeculative, MtpSpeculativeParams};
use std::time::Instant;

#[path = "mtp_verifier.rs"]
mod verification;
use verification::{candidate_count, keep_end, verify_prefix, TargetOracle};

/// First source experiment: at most one proposal, and one recurrent rollback plane.
/// A different depth requires its own memory/cap/rollback qualification.
const DRAFT_TOKENS: usize = 1;
// Bound draft compute buffers while keeping every logical prefill batch intact.
const DRAFT_MICROBATCH_TOKENS: u32 = 64;

pub(super) fn validate_model(model: &LlamaModel) -> Result<(), Failure> {
    let metadata = |key, expected: &str| {
        model
            .meta_val_str(key)
            .is_ok_and(|actual| actual == expected)
    };
    if !metadata("general.architecture", "qwen35")
        || !metadata("qwen35.nextn_predict_layers", "1")
        || !metadata("qwen35.block_count", "33")
        || model.n_embd() != 2560
        || model.n_layer() != 32
    {
        return Err(failed("mtp model"));
    }
    Ok(())
}

fn check_position(context: &LlamaContext<'_>, end: usize) -> Result<(), Failure> {
    if end == 0
        || end > CONTEXT_TOKENS as usize
        || context.kv_cache_seq_pos_max(0) != end as i32 - 1
    {
        return Err(failed("mtp position"));
    }
    Ok(())
}

fn check_context(context: &LlamaContext<'_>, minimum_microbatch: u32) -> Result<(), Failure> {
    if context.n_ctx() != CONTEXT_TOKENS
        || context.n_batch() < BATCH_TOKENS
        || context.n_ubatch() < minimum_microbatch
        || DRAFT_TOKENS + 1 > context.n_ubatch() as usize
    {
        return Err(failed("mtp context"));
    }
    Ok(())
}

fn remove_tail(context: &mut LlamaContext<'_>, begin: u32) -> Result<(), Failure> {
    if !context
        .clear_kv_cache_seq(Some(0), Some(begin), None)
        .map_err(|_| failed("mtp rollback"))?
    {
        return Err(failed("mtp rollback"));
    }
    check_position(context, begin as usize)
}

fn pick(
    engine: &Engine,
    spec: &MtpSpeculative<'_>,
    row: i32,
    grammar: &mut Option<LlamaSampler>,
    stats: &mut Stats,
    measured: &mut ExperimentalMtpStats,
) -> Result<LlamaToken, Failure> {
    let start = Instant::now();
    let (token, scanned) = engine.pick_from(spec.target_context(), row, grammar.as_mut());
    measured.pick_us += start.elapsed().as_micros() as u64;
    measured.pick_calls += 1;
    stats.grammar_scans += u32::from(scanned);
    if token.0 < 0 || token.0 >= engine.model.vocab().n_tokens() {
        return Err(failed("mtp target token"));
    }
    Ok(token)
}

fn emit(
    engine: &Engine,
    token: LlamaToken,
    grammar: &mut Option<LlamaSampler>,
    written: &mut Vec<u8>,
    stats: &mut Stats,
    measured: &mut ExperimentalMtpStats,
) {
    let start = Instant::now();
    if let Some(grammar) = grammar.as_mut() {
        grammar.accept(token);
    }
    engine
        .model
        .vocab()
        .token_to_piece_into(token, written, false, None);
    stats.answer_tokens += 1;
    stats.answer_hash = answer_hash(stats.answer_hash, token.0);
    measured.emit_us += start.elapsed().as_micros() as u64;
}

/// The production verifier and its tests share the complete accept/stop loop. This adapter
/// alone reads native target logits and commits to the live grammar, output and token hash.
struct NativeOracle<'a, 'model> {
    engine: &'a Engine,
    spec: &'a MtpSpeculative<'model>,
    grammar: &'a mut Option<LlamaSampler>,
    written: &'a mut Vec<u8>,
    stats: &'a mut Stats,
    measured: &'a mut ExperimentalMtpStats,
}

impl TargetOracle for NativeOracle<'_, '_> {
    type Token = LlamaToken;
    type Error = Failure;

    fn pick(&mut self, row: usize) -> Result<Option<LlamaToken>, Failure> {
        let token = pick(
            self.engine,
            self.spec,
            row as i32,
            self.grammar,
            self.stats,
            self.measured,
        )?;
        Ok((!self.engine.model.vocab().is_eog(token)).then_some(token))
    }

    fn commit(&mut self, token: LlamaToken) {
        emit(
            self.engine,
            token,
            self.grammar,
            self.written,
            self.stats,
            self.measured,
        );
    }
}

impl Engine {
    /// Contexts are constructed during each request, after the requested thread count is set.
    pub(in crate::model_helper) fn use_threads(
        &mut self,
        threads: Option<u32>,
    ) -> Result<(), Failure> {
        if let Some(threads) = threads {
            self.threads = i32::try_from(threads)
                .unwrap_or(i32::MAX)
                .clamp(1, self.batch_threads);
        }
        Ok(())
    }

    pub(in crate::model_helper) fn has_context(&self) -> bool {
        // No context/carryover survives a request; the model remains ready for a fresh one.
        true
    }

    /// Setup and the complete uncached prefill count as prompt time. Teardown counts as
    /// answer time, and experimentalMtp.totalUs includes all three. Model loading remains
    /// startup work, measured by the caller as for the ordinary helper.
    pub(super) fn generate(
        &mut self,
        tokens: &[LlamaToken],
        prefix_len: usize,
        max: usize,
        grammar_text: Option<&str>,
    ) -> Result<(String, bool), Failure> {
        if tokens.is_empty()
            || max == 0
            || tokens
                .len()
                .checked_add(max)
                .is_none_or(|end| end > CONTEXT_TOKENS as usize)
            || DRAFT_TOKENS + 1 > BATCH_TOKENS as usize
        {
            return Err(failed("too long"));
        }
        let started = Instant::now();
        self.stats = Stats::default();
        let target = self
            .model
            .new_context(
                self.backend,
                context_params(self.threads, self.batch_threads)
                    .with_n_seq_max(1)
                    .with_n_rs_seq(DRAFT_TOKENS as u32),
            )
            .map_err(|_| failed("mtp target"))?;
        let draft = self
            .model
            .new_context(
                self.backend,
                context_params(self.threads, self.batch_threads)
                    .with_n_seq_max(1)
                    .with_n_ubatch(DRAFT_MICROBATCH_TOKENS)
                    .with_context_type(LlamaContextType::Mtp),
            )
            .map_err(|_| failed("mtp draft"))?;
        check_context(&target, BATCH_TOKENS)?;
        check_context(&draft, DRAFT_MICROBATCH_TOKENS)?;
        let mut spec = MtpSpeculative::new(
            target,
            draft,
            MtpSpeculativeParams {
                n_max: DRAFT_TOKENS as i32,
                n_min: 0,
                p_min: 0.0,
            },
        )
        .map_err(|_| failed("mtp init"))?;
        spec.target_context_mut().clear_kv_cache();
        spec.draft_context_mut().clear_kv_cache();
        let mut measured = ExperimentalMtpStats {
            n_max: DRAFT_TOKENS as u32,
            rollback_capacity: DRAFT_TOKENS as u32,
            setup_us: started.elapsed().as_micros() as u64,
            ..ExperimentalMtpStats::default()
        };
        let mut stats = Stats {
            prompt_tokens: tokens.len() as u32,
            prefix_len: if prefix_len < tokens.len() {
                prefix_len as u32
            } else {
                0
            },
            answer_hash: ANSWER_HASH_START,
            threads: self.threads as u32,
            batch_threads: self.batch_threads as u32,
            // Explicitly no prefix restore and no legacy single-token timing claim.
            ..Stats::default()
        };
        let mut answer_started = None;
        let outcome = (|| {
            let mut grammar = grammar_text
                .map(|text| LlamaSampler::grammar(self.model, text, "root"))
                .transpose()
                .map_err(|_| failed("grammar"))?;
            let mut batch = LlamaBatch::new(BATCH_TOKENS as usize, 1);
            for (chunk_index, chunk) in tokens.chunks(BATCH_TOKENS as usize).enumerate() {
                batch.clear();
                for (offset, token) in chunk.iter().enumerate() {
                    let position = chunk_index * BATCH_TOKENS as usize + offset;
                    batch
                        .add(*token, position as i32, &[0], position + 1 == tokens.len())
                        .map_err(|_| failed("batch"))?;
                }
                let start = Instant::now();
                spec.target_context_mut()
                    .decode(&mut batch)
                    .map_err(|_| failed("mtp prefill"))?;
                check_position(
                    spec.target_context(),
                    chunk_index * BATCH_TOKENS as usize + chunk.len(),
                )?;
                measured.prefill_target_us += start.elapsed().as_micros() as u64;
                let start = Instant::now();
                spec.process(&batch).map_err(|_| failed("mtp process"))?;
                check_position(
                    spec.draft_context_mut(),
                    chunk_index * BATCH_TOKENS as usize + chunk.len(),
                )?;
                measured.prefill_draft_us += start.elapsed().as_micros() as u64;
            }
            // begin resets sampling, not hidden carryover. Fresh constructor + full process
            // above initialize that carryover for this document alone.
            spec.begin(tokens).map_err(|_| failed("mtp begin"))?;
            stats.prompt_ms = started.elapsed().as_millis() as u64;
            answer_started = Some(Instant::now());
            let mut written = Vec::new();
            let mut history = tokens.to_vec();
            let mut position = tokens.len();
            let mut pending = pick(
                self,
                &spec,
                batch.n_tokens() - 1,
                &mut grammar,
                &mut stats,
                &mut measured,
            )?;
            loop {
                if self.model.vocab().is_eog(pending) {
                    return Ok((written, false));
                }
                emit(
                    self,
                    pending,
                    &mut grammar,
                    &mut written,
                    &mut stats,
                    &mut measured,
                );
                batch.clear();
                batch
                    .add(pending, position as i32, &[0], true)
                    .map_err(|_| failed("batch"))?;
                // The final capped token is still decoded once, with no next-token pick.
                if stats.answer_tokens as usize == max {
                    let start = Instant::now();
                    spec.target_context_mut()
                        .decode(&mut batch)
                        .map_err(|_| failed("mtp decode"))?;
                    check_position(spec.target_context(), position + 1)?;
                    measured.verify_target_us += start.elapsed().as_micros() as u64;
                    measured.target_decode_calls += 1;
                    measured.target_decode_tokens += 1;
                    let start = Instant::now();
                    spec.process(&batch).map_err(|_| failed("mtp process"))?;
                    check_position(spec.draft_context_mut(), position + 1)?;
                    measured.catchup_us += start.elapsed().as_micros() as u64;
                    return Ok((written, true));
                }
                let start = Instant::now();
                let proposed = spec
                    .draft(position as i32, pending, &history)
                    .map_err(|_| failed("mtp propose"))?;
                measured.draft_us += start.elapsed().as_micros() as u64;
                if proposed.is_empty()
                    || proposed.len() > DRAFT_TOKENS
                    || proposed
                        .iter()
                        .any(|token| token.0 < 0 || token.0 >= self.model.vocab().n_tokens())
                {
                    return Err(failed("mtp proposal"));
                }
                measured.draft_rounds += 1;
                measured.drafted_tokens += proposed.len() as u32;
                let submitted =
                    candidate_count(&proposed, max - stats.answer_tokens as usize, |token| {
                        self.model.vocab().is_eog(*token)
                    });
                measured.submitted_tokens += submitted as u32;
                for (offset, token) in proposed[..submitted].iter().enumerate() {
                    batch
                        .add(*token, (position + offset + 1) as i32, &[0], true)
                        .map_err(|_| failed("batch"))?;
                }
                let start = Instant::now();
                remove_tail(spec.draft_context_mut(), position as u32)?;
                measured.rollback_us += start.elapsed().as_micros() as u64;
                let start = Instant::now();
                spec.target_context_mut()
                    .decode(&mut batch)
                    .map_err(|_| failed("mtp verify"))?;
                check_position(spec.target_context(), position + submitted + 1)?;
                measured.verify_target_us += start.elapsed().as_micros() as u64;
                measured.target_decode_calls += 1;
                measured.target_decode_tokens += batch.n_tokens() as u32;
                let start = Instant::now();
                spec.process(&batch).map_err(|_| failed("mtp process"))?;
                check_position(spec.draft_context_mut(), position + submitted + 1)?;
                measured.catchup_us += start.elapsed().as_micros() as u64;
                let verified = verify_prefix(
                    &proposed[..submitted],
                    max - stats.answer_tokens as usize,
                    &mut NativeOracle {
                        engine: self,
                        spec: &spec,
                        grammar: &mut grammar,
                        written: &mut written,
                        stats: &mut stats,
                        measured: &mut measured,
                    },
                )?;
                let accepted = verified.accepted;
                let end = keep_end(
                    position,
                    submitted,
                    accepted,
                    CONTEXT_TOKENS as usize,
                    DRAFT_TOKENS,
                )
                .ok_or_else(|| failed("mtp range"))?;
                let start = Instant::now();
                if accepted < submitted {
                    // Native recurrent rollback is deferred until the NEXT decode. Exactly
                    // one removal here; a second partial rollback would fail or lose its plane.
                    remove_tail(spec.target_context_mut(), end)?;
                    measured.target_rollbacks += 1;
                    measured.rollback_tokens += (submitted - accepted) as u32;
                } else {
                    check_position(spec.target_context(), end as usize)?;
                }
                remove_tail(spec.draft_context_mut(), end)?;
                // accept only rebinds pending_h to the accepted target hidden row. It does
                // NOT trim target/draft memory, and is illegal without a nonempty proposal.
                spec.accept(accepted as u16)
                    .map_err(|_| failed("mtp accept"))?;
                measured.rollback_us += start.elapsed().as_micros() as u64;
                measured.accepted_tokens += accepted as u32;
                measured.rejected_tokens += (proposed.len() - accepted) as u32;
                history.push(pending);
                history.extend_from_slice(&proposed[..accepted]);
                position = end as usize;
                if history.len() != position {
                    return Err(failed("mtp history"));
                }
                if verified.capped {
                    return Ok((written, true));
                }
                if verified.eog {
                    return Ok((written, false));
                }
                pending = verified.next.ok_or_else(|| failed("mtp progress"))?;
            }
        })();
        // Clean up on success AND error. Never retain native carryover for the next document.
        let teardown = Instant::now();
        spec.target_context_mut().clear_kv_cache();
        spec.draft_context_mut().clear_kv_cache();
        drop(spec);
        measured.teardown_us = teardown.elapsed().as_micros() as u64;
        let (written, capped) = outcome?;
        // Extra decoded inputs are exactly the rejected target suffixes. Picks count only
        // committed output plus the terminal EOG; a capped answer never performs a bonus pick.
        if measured.target_decode_tokens != stats.answer_tokens + measured.rollback_tokens
            || measured.pick_calls != stats.answer_tokens + u32::from(!capped)
            || measured.drafted_tokens != measured.accepted_tokens + measured.rejected_tokens
            || measured.submitted_tokens != measured.accepted_tokens + measured.rollback_tokens
            || (capped && stats.answer_tokens as usize != max)
        {
            return Err(failed("mtp accounting"));
        }
        let text = String::from_utf8_lossy(&written).into_owned();
        measured.total_us = started.elapsed().as_micros() as u64;
        stats.answer_ms =
            answer_started.map_or(0, |read: Instant| read.elapsed().as_millis() as u64);
        stats.capped = capped;
        stats.experimental_mtp = Some(measured);
        self.stats = stats;
        Ok((text, capped))
    }
}

# Opt-in Qwen3.5 MTP experiment

`experimental-mtp` is a Cargo feature, off by default. It enables the existing
`llama-cpp-2/common` feature and an experimental generation path for the current
Qwen3.5-4B layout: `qwen35`, one NextN block, 33 total blocks, 32 trunk layers and
2560-dimensional embeddings. The normal model loader validates tensor shapes.
The experiment uses the same model file and requires its built-in chat template;
unsupported models fail explicitly. There is no UI switch, environment toggle,
vendor patch or automatic fallback.

The model is loaded once with MTP tensors enabled. Each request creates a new
target context, MTP draft context and speculative driver, and drops all three
after success or failure. A driver's `begin()` resets its sampler, but does not
clear its native hidden-state carryover; it is not a request-reset mechanism.
This first experiment therefore does not reuse instruction-prefix state. The
ordinary build retains its existing context and prefix-cache behavior.

The first experiment proposes at most one token and gives the target one
recurrent rollback plane through the public `with_n_rs_seq(1)` API. Both contexts
use sequence zero, the existing context/batch bounds and the existing generation
and batch thread settings. Actual context capacities are checked before prefill.
Both logical batches remain 512 tokens. The target microbatch remains 512, while
the draft microbatch is 64 to reduce its compute-buffer reservation. The context
checks retain the 512-token logical capacity requirement for both contexts and
check their separate microbatch requirements. Full input batches still reach the
native draft processor; no prompt tokens are dropped or clipped. The native
source supports splitting these batches on the causal decoder path. The pinned
Rust wrapper has no public getter for the loaded causal-attention flag, so that
condition is checked in a separate native fixture. That fixture observed the
loaded draft flag as true for the pinned model; this does not qualify the
application build or other models.
Every target prefill batch is immediately processed by the draft driver; only
after complete prefill does `begin()` run.

During generation, one grammar-accepted target token is pending at position `p`.
The target verifies that token plus the non-EOG proposal prefix fitting the
answer budget. Only the existing grammar-aware greedy target selection can
accept a proposal. Accepted tokens advance the grammar, output and token hash
once; the first mismatch or EOG stops verification before any later logits are
used. The final capped token is decoded, without selecting a bonus token.

After accepting `k` of `m` submitted proposals, both memories retain positions
through `p+k`. A rejected target suffix requests exactly one partial rollback of
`m-k <= 1` tokens. The pinned recurrent implementation defers the snapshot copy
until the next decode; the application never issues a second partial target
rollback in between. Both the Rust removal result and native boolean must
succeed, and the resulting sequence position is checked. Draft provisional
memory is trimmed before target catch-up and again after rejection. `accept(k)`
then chooses the matching target hidden row; it does not perform either memory
rollback. EOG/failure teardown clears and drops the contexts instead of reusing
pending state. Empty, invalid or oversized proposals fail the request.

`experimentalMtp` statistics report context/driver setup, target and draft
prefill, target selection, emission, proposal generation, target verification,
draft catch-up, rollback and teardown separately. `totalUs` covers the complete
generation function, including setup and uncached prefill. The existing harness
`startMs` includes model startup; document `wallMs` also includes prompt
construction and post-processing. All costs must be included in comparisons.
Ordinary `answerTiming` is absent on the MTP path because its one-token decode
contract does not describe speculative batches. No document or token text is
added to statistics.

Successful requests check these identities:

- `pickCalls = answerTokens + (capped ? 0 : 1)`.
- `targetDecodeTokens = answerTokens + rollbackTokens`.
- `submittedTokens = acceptedTokens + rollbackTokens`.
- `draftedTokens = acceptedTokens + rejectedTokens`; rejected includes proposals
  truncated before target submission.

The model-independent verifier is shared by production and focused tests. Native
integration sources also cover refusal of the ordinary non-MTP tiny fixture and
the existing real-model request-isolation check, with explicit no-prefix-reuse
and timing/accounting assertions for MTP. Ordinary tiny-model positive tests
remain enabled in default builds; their Llama fixture cannot exercise this
Qwen-only feature.

Validation status: a standalone `rustc --edition=2021 --test` run of the exact
production verifier and its focused test module passed all 12 tests, with no
failures or ignored tests. A crate-root driver imports `mtp_verifier.rs` through
`#[path]`; that production module includes `mtp_verifier_tests.rs` under
`#[cfg(test)]`. This route uses only the Rust standard library. Rust formatting
and whitespace checks also passed.

For the draft-microbatch change, a separately admitted constructor-only native
fixture failed with a 512-token draft microbatch when reserving a 519,045,120-byte
compute buffer. Changing only the draft microbatch to 64 constructed both
contexts successfully under the same 5,160,511,456-byte data limit, with context
8192, logical batches 512 and three threads. The fixture used pinned cached
0.1.160 native archives; byte identity with the original production archives was
not established. It did not reproduce the application sandbox or execute
prefill, decode, generation or clinical inputs. This is constructor evidence
only, not an application build, inference, memory-peak or performance result.
The application memory cap and sandbox are unchanged.

A separately admitted native synthetic K1 fixture passed with all 513 prefill
tokens processed as logical batches of 512 and 1, with matching target/draft
positions after each call. Four K1 rounds covered one deliberately forced
zero-acceptance rollback of depth one, its following decode, and three natural
full acceptances. A final ordinary decode brought the total to eight committed
tokens. The forced round's proposal matched the target; no natural rejection
was observed. The expected nine internal microbatches are source-derived, not
an observed internal trace. The fixture used greedy non-EOG selection and did
not exercise production EOG handling or grammar. Its native logs were empty.
[Sanitized fixture source](https://github.com/carlos-emr/mycarlos/blob/8d6276b715dea13386f29a6a1196e998b7f32dd9/experiments/mtp-native-synthetic/v3-source/synthetic_k1.cpp)
and its [scope notes](https://github.com/carlos-emr/mycarlos/blob/8d6276b715dea13386f29a6a1196e998b7f32dd9/experiments/mtp-native-synthetic/v3-source/RESTORE.md)
in [PR322](https://github.com/carlos-emr/mycarlos/pull/322) distinguish the private
executed fixture from the public, uncompiled source copy.

Feature/default compilation of this successor and application integration checks,
production grammar and EOG behavior, request isolation, peak memory, quality and
real H10 timing still need separately admitted execution. The native synthetic
fixture does not establish application or sandbox qualification, nor byte
identity with the original production archives. Batched target arithmetic may
differ from single-token arithmetic, so control-flow verification does not establish
bit-identical baseline output. No speed gain or quality result is claimed. This
candidate needs its own binary and runtime qualification; prior timer or
helper-affinity results do not qualify it.

The source review uses `llama-cpp-2`/`llama-cpp-sys-2` 0.1.160, Rust commit
`0dd5814c9b061930965d144c1653cd4d05054873` and native commit
`d81235049384534c167caea52b85a694f6103d14`. Relevant APIs are
`context/params/get_set.rs`, `context/kv_cache.rs`, `speculative.rs`, native
`common/speculative.cpp` and `src/llama-memory-recurrent.cpp`.

# Retained GGUF loader corpus

`corpus.json` retains deterministic test inputs as recipes against the existing
hand-built, one-layer FAKE GGUF in `tests/model_engine.rs`. No downloaded weights
or patient data. The template, byte edits and truncations fully determine each
input; the harness writes its SHA-256-named `.gguf` before invoking the actual
sandboxed helper. Explicit expected outcomes cover the valid and template cases;
other cases may only pass or return a documented model/template/context refusal.
Unexpected process exits, signals, protocol errors and deadlines fail the oracle.
The unit tests include deliberate startup/decode crashes and hangs to check it.

The ordinary integration test replays this corpus. The separate ignored
`loader_mutation_campaign` test also applies fixed-seed byte mutations, cuts and
length/type edits. Set `MYCARLOS_FUZZ_OUTPUT` to a private retained directory and
`MYCARLOS_FUZZ_CASES` (1–4096, default 128). Run only through the coordinated heavy
slot with a hard outer timeout. Every input is retained before execution; an
unexpected result adds a diagnostic alongside it. Do not discard a failing case
or convert its result to a normal refusal. Triage findings privately.

This is dependency-free corpus replay and mutation validation. It is **not
coverage-guided fuzzing**. The design's coverage-guided loader-fuzz gate remains
open until adequate tooling and a bounded run have been independently verified.
No source here enables the unchecked renderer flow or authorizes publication.

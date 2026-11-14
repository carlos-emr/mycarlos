# Prompt0929 baseline O1 adapter source backup

This separate source snapshot targets PR #315 at `0929f4ac398bfb027021379a9dff448eb2814c21`. It preserves baseline application opt-level 1, debug information 2, debug assertions and overflow checks. It does not change or replace the O3 experiment backup.

The actual Cargo JSON parser requires three newly built artifacts with `fresh=false`. Runtime selection retains the original 22 native selectors and adds the exact changed prompt snapshot; the extraction wrapper brings the total to 24 invocations. This describes intended selection, not executed native tests.

At initial preparation, Root ran the seven synthetic parser controls with real process primitives blocked: 7 passed, zero failures, errors or skips. The legacy scratch suite was not rerun. No new native build, native execution qualification, model evaluation or performance result is claimed.

The manifest hashes the seven exact source files. This is not a portable execution package: local paths and imports require reconstruction under a separately reviewed private package. Policy, source/cache inventories, grants, bindings, holder proofs, credentials and runtime receipts are intentionally absent. Do not execute this snapshot without fresh Root admission and bounds.

Actual candidate ELF hashes remain unknown and READY binding remains unissued. A future actual build must preserve the compile-time helper path selected by Cargo; the model harness uses that target helper, not the extraction helper copy. The copied model harness is `bundle/harness`.

Later retained-target continuation and wrapper-manifest repair sources are backed up in the sibling `continuation-source` and `runtime-repair-source` directories. Their restore notes distinguish actual validation from pending qualification.

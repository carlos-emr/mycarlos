# V9 evaluation controller source backup

This experimental backup preserves the 18 controller and mock-test Python sources
plus their source-only manifest. The source bytes are unchanged from the reviewed
V9 package. It is not an installed app feature or a portable evaluation launcher.
No execution authority, runtime qualification or quality result comes with this
backup.

The controller bounds one evaluation phase, verifies its supplied identities and
inputs, observes owned processes through Linux pidfds and ptrace, and requires
process cleanup before reporting completion. Its shutdown handling distinguishes
observed process exit from contradictory identity or confinement evidence. Mock
tests cover those transitions, deadlines, dispatch and interface contracts.

The snapshot is tied to application commit
`6595b3c25beb32c2cbd44892698c3fd66265ad2f` and tree
`62c4705b58968c20abc69a5029b0ca6449aa08d7`. It contains fixed H10/M8 cohort counts,
CPU/nice requirements, a specific retained-marker path, and the absolute
2026-11-13 deadline. Those are historical constraints, not configurable defaults.
Changing them requires a separately reviewed successor and fresh qualification.
Historical comments about pending permission do not grant permission.

The repository is public. This directory contains only source, synthetic mock
fixtures, a source manifest and this document. Grants, runtime approvals,
execution receipts, private input documents, clinical outputs, models, credentials
and operational package/provenance reports are excluded.

## Restore source

Verify `source-manifest.json` before using its file list. Its SHA-256 is
`dfda87b8541fa946fb72cd056a4c3a83632fb8638c56018d51e9cc07adfb75d6`.
Then verify that its `files` keys are exactly the 18 Python filenames here and that
every file has the listed SHA-256. A static parse or hash check need not import or
execute any controller module.

To reconstruct an isolated source package, copy only those 18 Python files and
`source-manifest.json` into a new directory. Use independent regular files owned
by the intended runner user, with mode `0400`, one link each and no symlinks,
bytecode caches or native import files. Git does not preserve mode `0400`, so a
checkout alone does not satisfy the entry verifier. Python entry requires `-I -B`.
These restoration steps preserve source only; do not reuse old process IDs,
deadlines, hashes of runtime artifacts or execution grants.

The controller needs Linux facilities, separately verified binaries and model,
approved input inventory, a live bounded owner, and explicit freshly bound
execution authority. Those dependencies are deliberately absent. This snapshot
must not be invoked as a model command merely because it is available in Git.

## Validation scope

The original exact source passed 140 bounded mocked checks with real process,
native-library, signaling and scheduler primitives blocked, and source peer
review. This backup adds checksum equality, syntax parsing and a content audit;
it does not rerun native, model or kernel tests. Real qualification and results
remain separate from this source backup. No performance or quality improvement is
claimed.

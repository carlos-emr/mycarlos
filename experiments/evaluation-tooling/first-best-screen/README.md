# Primary ranking-loop O1/O3 screen

This standalone Rust source preserves the exact `first_best` body and primary logits iterator from application commit `6595b3c25beb32c2cbd44892698c3fd66265ad2f`. Its transparent i32 token mirrors the original token type. It has no native-engine or model dependency.

The screen uses deterministic finite synthetic arrays of 131072, 262144 and 524288 floats, with black-box inputs/results, warm repeated scans and tied maxima. Those sizes are not assertions about a real model vocabulary. Semantic assertions retain empty, tie, NaN and infinity behavior. O1/O3/O3/O1 runs use identical flags except optimization level. A single outer 9.5-second timeout plus a 0.5-second kill grace bounds both compilations, artifact hashing and all four runs on CPU0/nice19. Root must verify actual exit and descendant cleanup; partial or nonzero execution is inconclusive.

This component screen excludes grammar application and fallback filtering/allocation, native decode, actual changing logits/cache state, and engine cross-crate/inlining effects. Compare paired per-call times and repeat variation, with absolute cost reported separately. Four milliseconds is one percent of a 400ms/token reference; this comparison cannot establish actual engine critical-path share or whole-engine speedup.

Source review and shell syntax checks passed. Compilation and execution remain unperformed in this source snapshot. The command scripts retain their prepared local source/toolchain paths and need an independently reviewed restored location before use elsewhere. This backup contains source and hash metadata only, without actual execution grants or results.

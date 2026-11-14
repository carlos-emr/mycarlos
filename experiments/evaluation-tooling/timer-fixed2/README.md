# Fixed two-document timer diagnostic

This source snapshot specializes the V11 controller for timer candidate `12f8743d2f86ed1856c1e4df7d4e0724771742c9`. The separate T2 diagnostic has one T1 run, the original two full inputs, CPU mask 1234, three generation and batch threads, and a 600-second cap including cleanup. It has no ABBA sequence or helper-affinity mutation.

The diagnostic requires fresh timer native build/runtime and exact harness READY evidence. Historical H10 completion or another candidate's executable evidence cannot qualify it. The full expected build descriptor is pinned. Answer timing validation checks the five integer fields, the sampled-token and decoded-token counts for EOG versus capped answers, and the summed wall time against the enclosing answer duration.

The existing ownership, EXEC observation, task checks and cleanup functions are retained. H10/M8 branches remain to minimize the lifecycle delta, but the distinct T2 grant cannot authorize them. T2 cannot authorize grading, M8 or adoption.

The exact source passed 198 bounded pure mock checks and independent source review. Historical observer provenance is separate from new native qualification. No timer native build, READY run, model measurement, quality result or speed gain is claimed by this snapshot.

This backup contains only 23 Python sources, their source manifest and this README. It excludes actual grants, rosters, runtime approvals, qualification reports, model files and input/output contents. Synthetic fixtures provide no execution authority. Operational files and source freeze records remain private.

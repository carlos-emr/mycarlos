# Fixed-harness helper affinity diagnostic

This successor keeps the harness and its threads on CPUs 1–4 in all four legs. The unchanged native harness therefore starts its helper with three threads. At the authenticated kernel EXEC stop, before the helper’s first instruction, the controller sets that single helper’s affinity to 1234 for A or 124 for B. Both legs execute the same setter once. The helper’s subsequently created threads inherit its selected mask.

The transition requires the same bound process, birth, direct parent, actual EXEC stop, single leader task and nice10 before and after the syscall. It rejects a second helper and preserves strict executable and full startup argument checks. Harness task samples require 1234; helper task samples require the selected mask. The existing observer and base guard are byte-identical to the prior snapshot.

Distinct grant, plan, completion and export schemas identify this helper-only experiment. A separate Root-accepted qualification must bind the exact source package and actual positive A/B checks. Prior negative-only tiny controls do not qualify the new affinity mutation. A new four-leg ABBA experiment is required; the old experiment’s A1 result cannot be reused.

The fixed two inputs, three inference threads, 600-second diagnostic caps, normally completed H10 prerequisite, original native/model bytes and strict quality requirements remain unchanged. Official H10/M8 never enter the new mutation path. Root still owns actual chronology, grants and cleanup verification. This diagnostic cannot authorize M8 or adoption.

Validation: 213 bounded pure mock controls passed, including all 184 prior controls and 29 new controls; independent source/result review found no blockers. Exact source hashes, AST parsing and read-only package verification passed. Positive live affinity qualification and a new model experiment remain pending. This source backup includes no runtime authority, private inputs, actual reports or measured speed improvement.

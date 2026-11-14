# MTP constructor comparison sources

These two standalone C++ sources preserve a constructor-only memory experiment.
Both require `--constructor-only`, context 8192, logical batch 512, three threads,
and a 5,160,511,456-byte data limit. The target microbatch stays 512. The sole
behavioral difference between the variants is the draft microbatch: 512 or 64.
Neither source tokenizes, prefills, decodes, generates text, initializes a
speculative driver, or reads clinical input.

The private baseline returned exit 3 after its draft constructor could not
reserve a 519,045,120-byte compute buffer. The private 64-token draft variant
returned exit 0 with both contexts constructed under the same memory cap.
These results came from separately admitted executions using pinned cached
0.1.160 native archives. Identity with the original production archives was not
established. The constructors did not reproduce the application sandbox or
measure the loaded causal-attention flag. No application build, inference,
rollback, quality, peak-memory or speed claim follows from this comparison.

The model path in both public copies is `PRIVATE_UNSET`. The public files have
not been compiled or run; their hashes differ from the private fixture hashes.
`source-manifest.json` records that distinction. Recovery comments in the
sources describe their historical origin. Do not assign private execution
qualification to these public bytes.

The sources use the native C API and existing static llama, ggml, ggml-base and
ggml-cpu archives plus standard system libraries. They do not require Cargo or
llama common. Running them requires separately verified inputs, resource
ownership and an external timeout/cleanup plan; the sources contain an internal
45-second alarm and disable core dumps. Constructor logs are bounded, but log
lock contention can discard a message without marking truncation.

This directory contains only sanitized source, documentation and source hashes.
It includes no model, native archive, executable, raw run artifact, private path,
lock or runtime grant.

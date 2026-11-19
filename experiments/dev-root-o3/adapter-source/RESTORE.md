# Restoring this source snapshot

This is an intentionally unportable code backup. It does not contain authority to
run a stage, a complete runtime package, or a prediction of speed improvement.
Verify every file against `SOURCE-MANIFEST.json` before review or restoration.

The source derives from the existing owned-process native runner: `native_guard.py`
and its byte-identical support/scratch code retain the holder, private OFD lock,
source and predecessor receipts, finite budget, pidfd/subreaper ownership and
cleanup protocol. The adapter adds one root-crate O3 no-run compilation, strict
Cargo selection for helper/libtest/model_engine, native flag checks, and explicit
read-only ccache use. The build bound is 1800 seconds including cleanup; cache
and native runtime stages remain separately admitted, with earlier expiry winning.

`test_o3_artifacts.py` is the current synthetic parser control set. The seven tests
passed with real process primitives blocked. The inherited `scratch_driver.py`
is preserved protocol source; that does not claim its entire legacy O1 fixture
suite was rerun or adapted for the new O3 selector. No build has run.

The READY probe code retains the exact native-before-userspace stop flow. Its
binding is deliberately absent. A future owner must bind the exact current
coordinator source and the actual newly built harness identity, then independently
review and admit the source and fresh finite stage. A matching prompt fingerprint
is not executable qualification. The model harness embeds the original selected
helper path; preserve and verify that actual helper instead of redirecting it to
a copied bundle.

Do not restore old private grants, bindings, inventories, runtime reports or holder
proofs. They are intentionally excluded. Prepare fresh exact-source/cache metadata
through the existing owner process, use a new target and Cargo home, and preserve
currently qualified binaries. Do not copy target outputs, incremental symlinks,
hardlinked mutable files or old CMake trees. The shared ccache is read-only with
stats and hardlinks disabled; hit rates on a new target remain unmeasured.

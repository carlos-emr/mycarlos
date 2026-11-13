# Application-crate O3 comparison recipe

This is an unbuilt, unevaluated experiment recipe linked to #313. It changes no
application source or production profile. A separately admitted build of exact
source `6595b3c25beb32c2cbd44892698c3fd66265ad2f` would override only the application
crate's dev/test optimization level from 1 to 3. Debug assertions, overflow checks,
panic behavior, the model, prompts and native compiler flags remain unchanged.

The app's greedy vocabulary scan executes once per generated token in Rust. Its
share of total time is unknown: llama bindings and C++ kernels already use O3.
No speed or quality improvement is claimed. The release profile is O3, but the
checked-in evaluation installer workflow explicitly builds debug artifacts.

`BUILD-PLAN.json` gives the single no-run Cargo command, required actual helper and
harness JSON profiles, cache exclusions, finite build bound and existing native
qualification path. It is a reviewable recipe, not a launcher or grant. Never
reuse the currently qualified executable paths or treat matching summary prompt
fingerprints as native executable qualification. No cache copy, native build or model execution was performed. Seven
synthetic parser controls subsequently passed with real process primitives blocked.

Use a fresh target and a separately prepared regular-file registry cache. Do not
copy incremental symlinks, hardlinked mutable outputs or CMake trees carrying old
absolute paths. A cold build may exceed the bounded slot; that remains a failure
to fit, not authority for automatic retries or an extended deadline.

`adapter-source/` now preserves the exact reviewed runner, parser controls and
READY-probe source, with a hash manifest and restoration notes. Private runtime
bindings, policies, inventories, grants and evidence are excluded. It is not a
standalone runnable package or execution grant. The proposed separately admitted
build ceiling is 1800 seconds, including cleanup and losing to earlier expiry.

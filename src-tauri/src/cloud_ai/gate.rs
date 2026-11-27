// The cloud AI build gate (#72). This file holds ONLY the gate and the marker, so that
// `scripts/cloud-ai-gate.test.mjs` can compile it by itself with `rustc` under each combination of
// profile and feature and check both directions for real.
//
// **Which build is which.** The *release* profile (`mycarlos_release_profile`, set by build.rs from
// Cargo's `PROFILE`, or `debug_assertions` off: `tauri build`, the store and package builds) must
// never carry the feature. The *evaluation / development* profile (the debug profile, `debug_assertions`
// on: `tauri build --debug` for the evaluation installers, `tauri dev`, and every `cargo test`) may.
// The release-safety gate (`scripts/check-release-safety.mjs`) refuses the feature in a release build
// command and refuses the marker below in any store artifact; this gate is the compiler's side of the
// same rule.
//
// The two VERIFY values of the live contract check (see TESTING.md) still stand: until Ben's check
// they are only ever exercised by the tests and by whoever runs the check.

#[cfg(all(
    feature = "cloud-ai",
    not(test),
    any(not(debug_assertions), mycarlos_release_profile)
))]
compile_error!(
    "the cloud-ai feature is for evaluation and development builds only (the debug profile): a release build must not carry it (#72)"
);

/// The marker `scripts/release-safety` searches a built binary for: present exactly when the feature
/// is compiled in, so a store artifact that carries the cloud send is found and refused.
#[cfg(feature = "cloud-ai")]
#[used]
#[allow(dead_code)]
pub(crate) static CLOUD_AI_MARKER: [u8; 17] = *b"mycarlos-cloud-ai";

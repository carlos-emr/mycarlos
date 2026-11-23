//! The native side of sending one document's de-identified text to a cloud AI provider with the
//! patient's own key (#72; THREAT_MODEL AI-11 and NET-05, proposed). Compiled for tests and for
//! builds with the `cloud-ai` Cargo feature, which is off by default and not in release builds.
//!
//! The pieces, each testable with no network and no real key:
//!
//! - `request`: the one host, the model allow-list and the request, built from the re-checked
//!   text and nothing else;
//! - `response`: every status and body the provider can answer with, turned into an answer or a
//!   plain failure (never the body, never logged);
//! - `restore`: the placeholders put back in Rust, from the list of what was removed, with one
//!   shared fixture of cases that the page's TypeScript restore also runs;
//! - `send`: the order of events: re-check, native confirmation, the history entry BEFORE the
//!   send (a failed write sends nothing), the send through a `Transport`, validation, restore,
//!   and the history entry for the answer. A `Transport` is the only thing that touches a network;
//!   the tests supply a fake one.
//!
//! Not here, on purpose: the Tauri commands, the native dialog and the screens (later changes).

#[cfg(feature = "cloud-ai")]
pub(crate) mod client;
pub(crate) mod request;
pub(crate) mod response;
pub(crate) mod restore;
pub(crate) mod send;

// Until the live contract check pins the VERIFY values (the `anthropic-version` header and the
// shape of `output_config.format`, see TESTING.md), a release build cannot have the feature on.
#[cfg(all(feature = "cloud-ai", not(debug_assertions)))]
compile_error!(
    "the cloud-ai feature is not for release builds until the VERIFY values in cloud_ai/request.rs are pinned (#72)"
);

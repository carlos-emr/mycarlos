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
//! - `keytest`: the explicit key test (`GET /v1/models`), no document;
//! - `exchanges`: the one prepared send and the cancel flags;
//! - `commands` (only with the feature): the Tauri commands and the native confirmation.

#[cfg(feature = "cloud-ai")]
pub(crate) mod client;
pub(crate) mod exchanges;
pub(crate) mod keytest;
// The providers (Anthropic, OpenAI, Gemini): hosts, key shapes, request builders and the one address
// check. A skeleton, wired into the send path by the next change, so unused until then.
#[allow(dead_code)]
pub(crate) mod provider;
pub(crate) mod request;
pub(crate) mod response;
pub(crate) mod restore;
pub(crate) mod send;

#[cfg(feature = "cloud-ai")]
pub(crate) mod commands;

/// The one cloud session of the process, kept here (set when the app is built) so that EVERY way
/// the vault locks (the command, the idle backstop, a reset) can reach it without plumbing: a lock
/// drops what was prepared, stops a send that is running and turns consent off.
#[cfg(feature = "cloud-ai")]
static SESSION: std::sync::OnceLock<std::sync::Arc<commands::CloudSession>> =
    std::sync::OnceLock::new();

#[cfg(feature = "cloud-ai")]
pub(crate) fn install(session: std::sync::Arc<commands::CloudSession>) {
    let _ = SESSION.set(session);
}

/// Called wherever the vault locks or is reset.
#[cfg(feature = "cloud-ai")]
pub(crate) fn on_lock() {
    if let Some(session) = SESSION.get() {
        session.lock();
    }
}

// The build gate and the marker: see `gate.rs`. The feature compiles in test, evaluation and development
// builds (the debug profile) and does not compile in a release build.
mod gate;

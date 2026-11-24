//! Native-only iPhone push registration (#422 push design, piece 2). No command is exposed to
//! JavaScript: the app's own Rust code asks this plugin for the Apple device token, after the
//! patient has opted in. The token is held in memory by the caller and never stored by this plugin.
//!
//! UNVERIFIED until macOS CI compiles it: the Swift half cannot be built on Linux.
use serde::Deserialize;
use tauri::{plugin::PluginHandle, Manager, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ios_push);

struct Push<R: Runtime>(PluginHandle<R>);

/// What Apple gave this install: the device token (hex, lower case) and which Apple push service it
/// belongs to. A development build gets a sandbox token and TestFlight and App Store builds get a
/// production one; sending to the wrong host fails.
#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct Token {
    pub token: String,
    pub environment: String,
}

/// The system's answer to "may this app show notices?" as the plugin reads it (`notDetermined`,
/// `denied`, `authorized`, `provisional`, `ephemeral`, or `unknown`).
#[derive(Debug, Deserialize)]
pub struct Permission {
    pub status: String,
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("ios-push")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _app.manage(Push(_api.register_ios_plugin(init_plugin_ios_push)?));
            Ok(())
        })
        .build()
}

/// Asks for notice permission (the system question is shown here, once) and then for the device
/// token. `None` when the patient refuses, the system gives no token in time, or this is not an
/// iPhone.
pub async fn request_token<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<Token> {
    app.try_state::<Push<R>>()?
        .0
        .run_mobile_plugin_async::<Token>("requestToken", ())
        .await
        .ok()
}

/// The permission as it is now, without asking.
pub async fn permission<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<Permission> {
    app.try_state::<Push<R>>()?
        .0
        .run_mobile_plugin_async::<Permission>("permission", ())
        .await
        .ok()
}

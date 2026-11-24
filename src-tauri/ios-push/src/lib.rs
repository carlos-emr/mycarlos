//! Native-only iPhone push registration (#422 push design, piece 2). No command is exposed to
//! JavaScript: the app's own Rust code asks this plugin for the Apple device token, after the
//! patient has opted in. The token is held in memory by the caller and never stored by this plugin.
//! What the answers mean (a valid token, a known Apple service, why a refusal) is decided by the
//! app's own `ios_push` module, which is tested on every platform.
//!
//! UNVERIFIED until macOS CI compiles it: the Swift half cannot be built on Linux.
use tauri::{
    plugin::{mobile::PluginInvokeError, PluginHandle},
    Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ios_push);

struct Push<R: Runtime>(PluginHandle<R>);

/// Why the plugin gave no answer.
#[derive(Debug)]
pub enum Failure {
    /// The plugin rejected the ask; this is its reject text (`push_permission_refused`,
    /// `push_token_timeout`, `push_token_unavailable`).
    Rejected(Option<String>),
    /// The call itself failed (the webview, serialisation).
    Other,
    /// This build has no iPhone push plugin.
    NotAnIphone,
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

fn failure(error: PluginInvokeError) -> Failure {
    match error {
        PluginInvokeError::InvokeRejected(response) => {
            Failure::Rejected(response.message.or(response.code))
        }
        _ => Failure::Other,
    }
}

/// Asks for notice permission (the system question is shown here, once) and then for the device
/// token. The raw reply is `{token, environment}`; the caller checks it.
pub async fn request_token<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<serde_json::Value, Failure> {
    let push = app.try_state::<Push<R>>().ok_or(Failure::NotAnIphone)?;
    push.0
        .run_mobile_plugin_async::<serde_json::Value>("requestToken", ())
        .await
        .map_err(failure)
}

/// The permission as it is now, without asking: `{status}`.
pub async fn permission<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<serde_json::Value, Failure> {
    let push = app.try_state::<Push<R>>().ok_or(Failure::NotAnIphone)?;
    push.0
        .run_mobile_plugin_async::<serde_json::Value>("permission", ())
        .await
        .map_err(failure)
}

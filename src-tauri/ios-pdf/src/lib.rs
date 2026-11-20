//! Native-only iPhone PDF presentation. No commands are exposed to JavaScript.
use serde::Serialize;
use tauri::{plugin::PluginHandle, Manager, Runtime};

tauri::ios_plugin_binding!(init_plugin_ios_pdf);

struct Reader<R: Runtime>(PluginHandle<R>);

/// Established before exporting bytes; backgrounding invalidates this session.
pub async fn begin<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<u64> {
    #[derive(serde::Deserialize)]
    struct Session {
        epoch: u64,
    }
    app.state::<Reader<R>>()
        .0
        .run_mobile_plugin_async::<Session>("begin", ())
        .await
        .ok()
        .map(|session| session.epoch)
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("ios-pdf")
        .setup(|app, api| {
            app.manage(Reader(api.register_ios_plugin(init_plugin_ios_pdf)?));
            Ok(())
        })
        .build()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document<'a> {
    pub generation: u64,
    pub epoch: u64,
    pub data: &'a str,
    pub title: &'a str,
    pub close_label: &'a str,
    pub activity: tauri::ipc::Channel<()>,
}

/// Resolves when the reader closes, or rejects if WebKit could not show it.
pub async fn open<R: Runtime>(app: &tauri::AppHandle<R>, document: Document<'_>) -> bool {
    app.state::<Reader<R>>()
        .0
        .run_mobile_plugin_async::<serde::de::IgnoredAny>("open", document)
        .await
        .is_ok()
}

/// The generation also invalidates an older open still queued on the UI thread.
pub async fn close<R: Runtime>(app: &tauri::AppHandle<R>, generation: u64) {
    #[derive(Serialize)]
    struct Cancel {
        generation: u64,
    }
    let _ = app
        .state::<Reader<R>>()
        .0
        .run_mobile_plugin_async::<serde::de::IgnoredAny>("close", Cancel { generation })
        .await;
}

//! Native-only Android PDF presentation (#358). No commands are exposed to JavaScript: the
//! app's own Rust code calls this plugin, which shows a separate native dialog drawn with
//! `PdfRenderer`. The document arrives as the number of a sealed in-memory file (a memfd) in this
//! same process, never as a path or as bytes in a message.
use serde::Serialize;
use tauri::{plugin::PluginHandle, Manager, Runtime};

const PLUGIN_IDENTIFIER: &str = "ca.carlos.mycarlos.pdf";

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
    tauri::plugin::Builder::new("android-pdf")
        .setup(|app, api| {
            app.manage(Reader(
                api.register_android_plugin(PLUGIN_IDENTIFIER, "PdfReaderPlugin")?,
            ));
            Ok(())
        })
        .build()
}

/// The words the reader shows and speaks; `{page}` and `{total}` in the two page texts are
/// filled in by the plugin.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Labels<'a> {
    pub close: &'a str,
    pub previous: &'a str,
    pub next: &'a str,
    pub zoom_in: &'a str,
    pub zoom_out: &'a str,
    pub page: &'a str,
    pub page_status: &'a str,
    /// "Page {page} of {total} could not be shown": the same placeholders.
    pub page_failed: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document<'a> {
    pub generation: u64,
    pub epoch: u64,
    /// A sealed memfd of this process; the plugin duplicates it and the caller closes its own.
    pub fd: i32,
    pub size: u64,
    pub title: &'a str,
    pub labels: Labels<'a>,
    pub activity: tauri::ipc::Channel<()>,
}

/// Resolves when the reader closes, or rejects if `PdfRenderer` could not show it.
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

/// The name an Android document provider gives a picked `content://` document
/// (`OpenableColumns.DISPLAY_NAME`, asked of the `ContentResolver`), or `None` when the provider
/// has none, does not answer, or the question fails. The id of such a document is often opaque
/// ("msf:31"); the provider's name is what says it is a video. It is another app's text: the caller
/// uses it only after checking it (`routing_name`). It never fails the caller.
pub async fn display_name<R: Runtime>(app: &tauri::AppHandle<R>, url: &str) -> Option<String> {
    #[derive(Serialize)]
    struct Request<'a> {
        url: &'a str,
    }
    #[derive(serde::Deserialize)]
    struct Reply {
        name: Option<String>,
    }
    app.state::<Reader<R>>()
        .0
        .run_mobile_plugin_async::<Reply>("displayName", Request { url })
        .await
        .ok()
        .and_then(|reply| reply.name)
}

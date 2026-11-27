//! Android native transport only. No renderer commands, enrollment or content collection.
//! A native owner must persist Policy consent/reservation before enable, durably queue
//! revocation before disable, and use a separate scoped enrollment credential for Portal.
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{PluginHandle, TauriPlugin},
    Manager, Runtime,
};
use zeroize::Zeroize;

pub struct AndroidPush<R: Runtime>(PluginHandle<R>);

// Intentionally no Debug/Serialize: provider tokens must never enter logs or renderer IPC.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub enabled: bool,
    pub generation: u64,
    pub token: Option<String>,
    pub reconcile: bool,
    pub permission: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedCredential {
    pub subscription_id: uuid::Uuid,
    pub epoch: uuid::Uuid,
    pub installation_id: uuid::Uuid,
    pub expires_at: u64,
    credential: String,
}
impl ScopedCredential {
    pub fn bearer(&self) -> &str {
        &self.credential
    }
}
impl Drop for ScopedCredential {
    fn drop(&mut self) {
        self.credential.zeroize();
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialRequest<'a> {
    subscription_id: uuid::Uuid,
    epoch: uuid::Uuid,
    installation_id: uuid::Uuid,
    expires_at: u64,
    credential: &'a str,
}

impl<R: Runtime> AndroidPush<R> {
    /// Fresh unlocked native owner only, after server-issued destination-scoped grant.
    /// No renderer command receives the credential. The caller must never substitute vault or pickup keys here.
    pub fn store_credential(
        &self,
        grant: &ScopedCredential,
    ) -> Result<(), tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin(
            "storeCredential",
            CredentialRequest {
                subscription_id: grant.subscription_id,
                epoch: grant.epoch,
                installation_id: grant.installation_id,
                expires_at: grant.expires_at,
                credential: &grant.credential,
            },
        )
    }
    pub fn load_credential(
        &self,
        destination: &crate::android_push_owner::DestinationRef,
    ) -> Result<ScopedCredential, tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin(
            "loadCredential",
            CredentialRequest {
                subscription_id: destination.subscription_id,
                epoch: destination.epoch,
                installation_id: destination.installation_id,
                expires_at: 0,
                credential: "",
            },
        )
    }
    /// Only after server tombstone acknowledgment; preserve credential for pending revocation.
    pub fn remove_credential(
        &self,
        destination: &crate::android_push_owner::DestinationRef,
    ) -> Result<(), tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin(
            "removeCredential",
            CredentialRequest {
                subscription_id: destination.subscription_id,
                epoch: destination.epoch,
                installation_id: destination.installation_id,
                expires_at: 0,
                credential: "",
            },
        )
    }
    pub fn snapshot(&self) -> Result<Snapshot, tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin("snapshot", ())
    }
    pub fn request_permission(&self) -> Result<(), tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin("requestPermission", ())
    }
    pub fn enable_transport(&self) -> Result<(), tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin("enableTransport", ())
    }
    pub fn disable_transport(&self) -> Result<(), tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin("disableTransport", ())
    }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("android-push")
        .setup(|app, api| {
            let handle = api.register_android_plugin("ca.carlos.mycarlos.push", "PushPlugin")?;
            app.manage(AndroidPush(handle));
            Ok(())
        })
        .build()
}

/// Pin each callback to the vault and session selected at receipt. Each vault can have one
/// queued check while the worker is busy. No provider data enters the webview.
pub(crate) fn listen<R: Runtime>(
    app: &tauri::AppHandle<R>,
    stores: crate::vault_source::StoreHandle,
) -> std::io::Result<()> {
    use crate::document_notifications::NoticeToken;
    use std::sync::{Arc, Mutex};
    use tauri::ipc::{Channel, InvokeResponseBody};
    let plugin = app.state::<AndroidPush<R>>().0.clone();
    std::thread::Builder::new()
        .name("android-notice-inbox".into())
        .spawn(move || {
            let (wake, receiver) = std::sync::mpsc::sync_channel(1);
            let pending = Arc::new(Mutex::new(
                crate::android_push_queue::PendingNotices::default(),
            ));
            let incoming = Arc::clone(&pending);
            let channel = Channel::<String>::new(move |body| {
                if let InvokeResponseBody::Json(json) = body {
                    if let Ok(value) = serde_json::from_str::<String>(&json) {
                        if let Ok(token) = NoticeToken::parse(&value) {
                            incoming
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .push(Arc::clone(stores.arc()), token);
                            let _ = wake.try_send(());
                        }
                    }
                }
                Ok(())
            });
            if plugin
                .run_mobile_plugin::<()>("listen", serde_json::json!({ "channel": channel }))
                .is_err()
            {
                return;
            }
            for () in receiver {
                let cues = pending.lock().unwrap_or_else(|p| p.into_inner()).take();
                for cue in cues {
                    #[derive(Deserialize)]
                    struct Allowed {
                        allowed: bool,
                    }
                    if plugin
                        .run_mobile_plugin::<Allowed>("receiveAllowed", ())
                        .is_ok_and(|state| state.allowed)
                    {
                        cue.store.android_notice_received(
                            cue.session,
                            &cue.token,
                            |session| cue.store.check_documents(session),
                            || {
                                let _ = plugin.run_mobile_plugin::<()>("showGeneric", ());
                            },
                        );
                    }
                }
            }
        })?;
    Ok(())
}

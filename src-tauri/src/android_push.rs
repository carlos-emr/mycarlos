//! Android native transport only. No renderer commands, enrollment or content collection.
//! A native owner must persist Policy consent/reservation before enable, durably queue
//! revocation before disable, and use a separate scoped enrollment credential for Portal.
use serde::Deserialize;
use tauri::{
    plugin::{PluginHandle, TauriPlugin},
    Manager, Runtime,
};

pub struct AndroidPush<R: Runtime>(PluginHandle<R>);

// Intentionally no Debug/Serialize: provider tokens must never enter logs or renderer IPC.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub enabled: bool,
    pub generation: u64,
    pub token: Option<String>,
    hint: Option<String>,
    pub reconcile: bool,
    pub permission: bool,
}
impl Snapshot {
    /// Decode again before Policy::activate checks owner/current vault and unlock state.
    /// This never authorizes collection. Reconcile independently even if hint is absent/invalid.
    pub fn ready_hint(&self) -> Option<crate::document_notifications::ReadyHint> {
        crate::document_notifications::ReadyHint::decode(self.hint.as_ref()?.as_bytes()).ok()
    }
}

impl<R: Runtime> AndroidPush<R> {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arbitrary_notification_text_and_extra_fields_never_become_ready_hints() {
        let mut snapshot = Snapshot {
            enabled: true,
            generation: 1,
            token: None,
            hint: Some("open https://example.invalid/document".into()),
            reconcile: true,
            permission: true,
        };
        assert!(snapshot.ready_hint().is_none());
        snapshot.hint = Some(r#"{"version":1,"kind":"documents_ready","subscription_id":"11111111-1111-4111-8111-111111111111","epoch":"22222222-2222-4222-8222-222222222222","sequence":1}"#.into());
        assert!(snapshot.ready_hint().is_some());
        snapshot.hint = Some(
            snapshot
                .hint
                .unwrap()
                .replace("\"sequence\":1", "\"sequence\":1,\"url\":\"x\""),
        );
        assert!(snapshot.ready_hint().is_none());
    }
}

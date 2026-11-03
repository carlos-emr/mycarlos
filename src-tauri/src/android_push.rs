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
    /// Called synchronously by Lifecycle::display_foreground under native ownership lock.
    pub fn show_foreground(
        &self,
        notice: crate::android_push_owner::ForegroundNotice,
    ) -> Result<(), tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin(
            "showGeneric",
            serde_json::json!({
                "readyHint": std::str::from_utf8(notice.hint()).unwrap_or("")
            }),
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

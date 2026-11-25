//! The iPhone-only half of the push handle: the Keychain through the plugin, and the two commands'
//! asks of Apple. Everything it decides is in `ios_push_handles` and the vault; this only calls the
//! plugin. UNVERIFIED until macOS CI compiles it (no iOS target can build it on Linux).

use crate::ios_push_handles::{digest_from_hex, digest_to_hex, HandleMemory};
use tauri::AppHandle;
use uuid::Uuid;

/// The Keychain as a `HandleMemory`. Its calls block, so it is used off the main thread only.
pub(crate) struct KeychainMemory(pub(crate) AppHandle);

impl HandleMemory for KeychainMemory {
    fn recall(&self, destination: Uuid) -> Option<[u8; 32]> {
        tauri_plugin_ios_push::recall_handle(&self.0, &destination.to_string())
            .ok()
            .flatten()
            .and_then(|text| digest_from_hex(&text))
    }
    fn remember(&self, destination: Uuid, digest: [u8; 32]) -> bool {
        tauri_plugin_ios_push::remember_handle(
            &self.0,
            &destination.to_string(),
            &digest_to_hex(&digest),
        )
        .is_ok()
    }
    fn forget(&self, destination: Uuid) {
        let _ = tauri_plugin_ios_push::forget_handle(&self.0, &destination.to_string());
    }
}

//! The native half of `PortalTrustPlugin.nativeInit` (Android only). The exported symbol lives in
//! the app's own library, not in the plugin crate, so the linker cannot drop it as unused; the
//! work is in `tauri_plugin_android_trust::initialize`, which builds and is tested on a host.
use jni::objects::{JClass, JObject};
use jni::EnvUnowned;

/// `ca.carlos.mycarlos.trust.PortalTrustPlugin.nativeInit(context)`.
#[no_mangle]
pub extern "system" fn Java_ca_carlos_mycarlos_trust_PortalTrustPlugin_nativeInit<'caller>(
    env: EnvUnowned<'caller>,
    _class: JClass<'caller>,
    context: JObject<'caller>,
) {
    tauri_plugin_android_trust::initialize(env, context);
}

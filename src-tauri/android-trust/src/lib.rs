//! Android's certificate trust for the portal connection, set up before anything asks for it
//! (the Android portal connection, piece 1: no behaviour change yet).
//!
//! The platform verifier asks Android's own trust manager, which applies the app's network
//! security config (system authorities only in a release build). It can only do that once it has
//! been given the JVM, the application `Context` and that context's class loader, because its
//! Kotlin half is found through the app's class loader and a bare native thread cannot see app
//! classes. So the Kotlin plugin `PortalTrustPlugin` hands the **application** context (never the
//! activity, which it would keep alive) to [`initialize`] once, when the plugin loads.
//!
//! Failure is closed: until [`verifier_ready`] is true nothing may build a TLS client for the portal.
//! Nothing here logs a value or touches the network.
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "android")]
use jni::{errors::Error, objects::JObject, EnvUnowned};

static READY: AtomicBool = AtomicBool::new(false);

/// Whether the platform verifier was initialised with the application context. False before the
/// plugin has loaded, and false for good if initialisation failed.
pub fn verifier_ready() -> bool {
    READY.load(Ordering::Acquire)
}

/// Registers the Kotlin plugin on Android (a no-op elsewhere, so the crate also builds on a host).
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("android-trust")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("ca.carlos.mycarlos.trust", "PortalTrustPlugin")?;
            Ok(())
        })
        .build()
}

/// The body of the native method `PortalTrustPlugin.nativeInit(context)`: initialises the verifier
/// once from the application context. A second call does nothing; a failure (or a panic) leaves
/// [`verifier_ready`] false and is not reported to Java, so the app keeps running without the
/// portal connection rather than crashing.
#[cfg(target_os = "android")]
pub fn initialize(mut env: EnvUnowned<'_>, context: JObject<'_>) {
    if verifier_ready() {
        return;
    }
    let outcome = env.with_env(|env| -> Result<(), Error> {
        rustls_platform_verifier::android::init_with_env(env, context)?;
        READY.store(true, Ordering::Release);
        Ok(())
    });
    outcome.resolve::<jni::errors::LogErrorAndDefault>();
}

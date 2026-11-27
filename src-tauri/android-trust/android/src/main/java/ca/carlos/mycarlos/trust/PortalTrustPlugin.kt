package ca.carlos.mycarlos.trust

import android.app.Activity
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin

/**
 * Gives the Rust side what the platform certificate verifier needs: the application Context (and
 * through it the app's class loader, which finds the verifier's Kotlin classes from a native
 * thread). Runs once, when the plugin loads. The application context is passed, never the
 * activity, so nothing keeps an activity alive. Nothing is sent anywhere and nothing is logged.
 */
@TauriPlugin
class PortalTrustPlugin(activity: Activity) : Plugin(activity) {
    init {
        nativeInit(activity.applicationContext)
    }

    companion object {
        // Implemented in the app's own library (src-tauri/src/android_trust.rs). Static, so the
        // symbol is `Java_ca_carlos_mycarlos_trust_PortalTrustPlugin_nativeInit`.
        @JvmStatic
        external fun nativeInit(context: android.content.Context)
    }
}

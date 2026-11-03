package ca.carlos.mycarlos.push

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.messaging.FirebaseMessaging

/** Native-only bridge: no renderer permission/command is granted for this plugin. */
@TauriPlugin
class PushPlugin(private val activity: Activity) : Plugin(activity) {
    override fun load(webView: WebView) { capture(activity.intent) }
    override fun onNewIntent(intent: Intent) { capture(intent) }
    private fun capture(intent: Intent?) {
        PushState.hint(activity, intent?.getStringExtra("ready_hint"))
        intent?.removeExtra("ready_hint")
    }
    @Command fun snapshot(invoke: Invoke) {
        val result = PushState.snapshot(activity)
        result.put("permission", permitted())
        invoke.resolve(JSObject(result.toString()))
    }
    private fun permitted(): Boolean =
        (Build.VERSION.SDK_INT < 33 || activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
        activity.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    // Caller requires explicit consent + native persisted Policy reservation. Permission request
    // does not enable transport. Native owner retries after observing the OS permission result.
    @Command fun requestPermission(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= 33 && !permitted())
            activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7412)
        invoke.resolve()
    }
    @Command fun enableTransport(invoke: Invoke) {
        if (!permitted()) { invoke.reject("push_permission_required"); return }
        ReadyMessagingService.ensureChannel(activity.getSystemService(NotificationManager::class.java))
        PushState.enable(activity, true)
        val ticket = PushState.ticket(activity)
        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = true
        messaging.token.addOnCompleteListener { task ->
            if (!task.isSuccessful) { invoke.reject("push_token_unavailable"); return@addOnCompleteListener }
            PushState.fetchedToken(activity, task.result, ticket)
            invoke.resolve()
        }
    }
    @Command fun disableTransport(invoke: Invoke) {
        // Native owner persists server revocation FIRST; this is local transport shutdown only.
        PushState.enable(activity, false)
        activity.getSystemService(NotificationManager::class.java).cancel(ReadyMessagingService.TAG, 1)
        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = false
        messaging.deleteToken().addOnCompleteListener { task ->
            if (task.isSuccessful) invoke.resolve() else invoke.reject("push_token_delete_pending")
        }
    }
}

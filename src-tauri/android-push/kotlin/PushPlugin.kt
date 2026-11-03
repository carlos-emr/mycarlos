package ca.carlos.mycarlos.push

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.PendingIntent
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.WebView
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.messaging.FirebaseMessaging

@InvokeArg
class NoticeArgs { var readyHint: String = "" }

@InvokeArg
class CredentialArgs {
    var subscriptionId: String = ""
    var epoch: String = ""
    var installationId: String = ""
    var expiresAt: Long = 0
    var credential: String = ""
}

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
    @Command fun showGeneric(invoke: Invoke) {
        if (!PushState.enabled(activity) || !permitted() || !activity.hasWindowFocus()) {
            invoke.reject("push_display_not_allowed"); return
        }
        val hint = invoke.parseArgs(NoticeArgs::class.java).readyHint
        if (hint.toByteArray(Charsets.UTF_8).size > 256) { invoke.reject("push_invalid_hint"); return }
        val manager = activity.getSystemService(NotificationManager::class.java)
        ReadyMessagingService.ensureChannel(manager)
        val launch = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
        if (launch == null) { invoke.reject("push_display_unavailable"); return }
        launch.putExtra("ready_hint", hint)
        val pending = PendingIntent.getActivity(activity, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(activity, ReadyMessagingService.CHANNEL)
                      else Notification.Builder(activity)
        manager.notify(ReadyMessagingService.TAG, 1, builder
            .setSmallIcon(ca.carlos.mycarlos.R.drawable.mycarlos_push)
            .setContentTitle("myCarlos").setContentText("A new document is available in myCarlos.")
            .setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(true).setContentIntent(pending).build())
        invoke.resolve()
    }
    @Command fun storeCredential(invoke: Invoke) {
        val a = invoke.parseArgs(CredentialArgs::class.java)
        try {
            ScopedCredentialStore.put(activity, a.subscriptionId, a.epoch, a.installationId, a.expiresAt, a.credential)
            invoke.resolve()
        } catch (_: Exception) { invoke.reject("push_credential_store_failed") }
    }
    @Command fun loadCredential(invoke: Invoke) {
        val a = invoke.parseArgs(CredentialArgs::class.java)
        val value = try { ScopedCredentialStore.get(activity, a.subscriptionId, a.epoch, a.installationId) }
                    catch (_: Exception) { null }
        if (value == null) invoke.reject("push_credential_unavailable") else invoke.resolve(JSObject(value.toString()))
    }
    @Command fun removeCredential(invoke: Invoke) {
        val a = invoke.parseArgs(CredentialArgs::class.java)
        try { ScopedCredentialStore.remove(activity, a.subscriptionId); invoke.resolve() }
        catch (_: Exception) { invoke.reject("push_credential_remove_failed") }
    }

}

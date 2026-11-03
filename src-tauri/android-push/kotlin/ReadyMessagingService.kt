package ca.carlos.mycarlos.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class ReadyMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { PushState.token(this, token) }
    override fun onDeletedMessages() { PushState.hint(this, null) }
    override fun onMessageReceived(message: RemoteMessage) {
        if (!PushState.enabled(this)) return
        PushState.hint(this, message.data["ready_hint"])
        // Data-only messages never stand in for reliable OS display or background collection.
        // Legacy HTTP v1 notification+data is displayed by FCM itself while backgrounded.
        if (message.notification == null) return
        val manager = getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) return
        ensureChannel(manager)
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
        launch.putExtra("ready_hint", message.data["ready_hint"]?.takeIf {
            it.toByteArray(Charsets.UTF_8).size <= 256
        })
        val pending = PendingIntent.getActivity(this, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        // Never display provider supplied text, images, URLs or document identifiers.
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL)
                      else Notification.Builder(this)
        manager.notify(TAG, 1, builder.setSmallIcon(ca.carlos.mycarlos.R.drawable.mycarlos_push)
            .setContentTitle("myCarlos").setContentText("A new document is available in myCarlos.")
            .setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(true)
            .setContentIntent(pending).build())
    }
    companion object {
        const val CHANNEL = "mycarlos-ready-v1"
        const val TAG = "mycarlos-ready"
        fun ensureChannel(manager: NotificationManager) {
            if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "myCarlos", NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { lockscreenVisibility = Notification.VISIBILITY_PRIVATE })
        }
    }
}

package ca.carlos.mycarlos.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class ReadyMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { PushState.token(this, token) }
    override fun onDeletedMessages() { PushState.hint(this, null) }
    override fun onMessageReceived(message: RemoteMessage) {
        if (!PushState.enabled(this)) return
        // Inbox only. No display/collection occurs before the Rust lifecycle owner validates
        // current consent, native owner, subscription epoch, permission and sequence.
        PushState.hint(this, message.data["ready_hint"])
        // Background HTTP v1 notification+data is displayed by FCM/OS directly. Server-side
        // generic-template/consent/revocation controls are required before provider enrollment.
    }
    companion object {
        const val CHANNEL = "mycarlos-ready-v1"
        const val TAG = "mycarlos-ready"
        fun ensureChannel(manager: android.app.NotificationManager) {
            if (android.os.Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
                android.app.NotificationChannel(CHANNEL, "myCarlos", android.app.NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE })
        }
    }
}

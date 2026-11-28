package ca.carlos.mycarlos.push

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class ReadyMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { PushState.token(this, token) }

    override fun onMessageReceived(message: RemoteMessage) {
        val notice = noticeToken(message.data) ?: return
        if (permitted(this)) PushState.receive(this, notice)
    }

    companion object {
        const val CHANNEL = "mycarlos-ready-v1"
        const val TAG = "mycarlos-ready"
        private val tokenShape = Regex("[A-Za-z0-9_-]{22}")

        // The Portal puts its opaque token in data.n. The title, body, click action and
        // every other provider field are excluded from the native message.
        fun noticeToken(data: Map<String, String>): String? =
            if (data.size == 1) data["n"]?.takeIf(tokenShape::matches) else null

        fun manager(c: Context) =
            c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        fun permitted(c: Context): Boolean =
            (Build.VERSION.SDK_INT < 33 || c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            (Build.VERSION.SDK_INT < 24 || manager(c).areNotificationsEnabled()) &&
            (Build.VERSION.SDK_INT < 26 || manager(c).getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE)

        fun ensureChannel(c: Context) {
            if (Build.VERSION.SDK_INT >= 26) manager(c).createNotificationChannel(
                NotificationChannel(CHANNEL, "myCarlos", NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { lockscreenVisibility = Notification.VISIBILITY_PRIVATE })
        }

        // Only the native authenticated-check path, or the separate test APK's explicit
        // local preview, calls this. A tap opens the ordinary app with no extras or links.
        fun showGeneric(c: Context): Boolean {
            if (!permitted(c)) return false
            ensureChannel(c)
            val launch = android.content.Intent(c, ca.carlos.mycarlos.MainActivity::class.java)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP or android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP)
            val pending = PendingIntent.getActivity(c, 0, launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(c, CHANNEL)
                          else Notification.Builder(c)
            manager(c).notify(TAG, 1, builder.setSmallIcon(ca.carlos.mycarlos.R.drawable.mycarlos_push)
                .setContentTitle("myCarlos")
                .setContentText(c.getString(ca.carlos.mycarlos.R.string.mycarlos_push_new_document))
                .setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(true).setContentIntent(pending).build())
            return true
        }
    }
}

package ca.carlos.mycarlos.push

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** Installed only in the isolated synthetic debug application. No vault, Firebase or Portal. */
class NoticePreviewActivity : Activity() {
    private lateinit var status: TextView

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        status = TextView(this).apply { text = "Local test on this device. Uses a fake document notice." }
        layout.addView(status)
        layout.addView(Button(this).apply {
            text = "Show test notice"
            setOnClickListener {
                if (Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 31)
                } else preview()
            }
        })
        setContentView(layout)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode == 31) preview()
    }

    private fun preview() {
        val payload = mapOf("n" to "AbCdEfGhIjKlMnOpQr-_01")
        check(ReadyMessagingService.noticeToken(payload) == payload["n"])
        check(ReadyMessagingService.noticeToken(payload + ("url" to "unused")) == null)
        check(ReadyMessagingService.noticeToken(mapOf("ready_hint" to "{}")) == null)
        status.text = if (ReadyMessagingService.showGeneric(this)) "Test notice sent"
                      else "Notifications are off"
    }
}

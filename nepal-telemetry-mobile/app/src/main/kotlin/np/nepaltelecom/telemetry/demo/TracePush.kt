package np.nepaltelecom.telemetry.demo

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Push for trace requests (2026-10-06). The server sends a data-only, high-priority
 * message, so Android delivers it even when the app is closed, the phone is locked,
 * or it's idle. The message says only that a request exists. The notification
 * shows Accept and Reject. The request details stay on the server until the user acts.
 */
object FcmToken {
    private const val PREFS = "dtwatch_device"
    private const val KEY_TOKEN = "fcm_token"
    private const val KEY_REGISTERED = "registered"

    /** Asks Firebase for this phone's token and sends it to the server once the phone is registered. */
    fun fetchAndUpload(context: Context) {
        try {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                save(context, token)
                uploadIfRegistered(context, token)
            }
        } catch (_: Exception) {
            // Firebase isn't configured on this build yet. Registration still works without push.
        }
    }

    fun save(context: Context, token: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_TOKEN, token).apply()
    }

    fun uploadIfRegistered(context: Context, token: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_REGISTERED, false)) return
        Thread { runCatching { TraceApi.putFcmToken(token) } }.start()
    }
}

class TraceMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        FcmToken.save(this, token)
        FcmToken.uploadIfRegistered(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["type"] != TYPE_TRACE_REQUEST) return
        val requestId = data["request_id"] ?: return
        showRequestNotification(requestId)
    }

    private fun showRequestNotification(requestId: String) {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.push_channel), NotificationManager.IMPORTANCE_HIGH)
            )
        }
        val openApp = PendingIntent.getActivity(
            this, requestId.hashCode(), Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(getString(R.string.push_title))
            .setContentText(getString(R.string.push_text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(openApp)
            .addAction(0, getString(R.string.push_accept), actionIntent(requestId, ACTION_ACCEPT))
            .addAction(0, getString(R.string.push_reject), actionIntent(requestId, ACTION_REJECT))
            .build()
        manager.notify(notificationId(requestId), notification)
    }

    private fun actionIntent(requestId: String, action: String): PendingIntent {
        val intent = Intent(this, TraceActionReceiver::class.java)
            .setAction(action)
            .putExtra(TraceActionReceiver.EXTRA_REQUEST_ID, requestId)
        return PendingIntent.getBroadcast(
            this, (requestId + action).hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        const val TYPE_TRACE_REQUEST = "trace_request"
        const val CHANNEL_ID = "trace_requests"
        const val ACTION_ACCEPT = "np.nepaltelecom.telemetry.demo.TRACE_ACCEPT"
        const val ACTION_REJECT = "np.nepaltelecom.telemetry.demo.TRACE_REJECT"

        fun notificationId(requestId: String): Int = requestId.hashCode()
    }
}

/**
 * Handles Accept and Reject from the notification. Accept also starts location
 * sharing for that request, using the expiry the server reports, so sharing
 * starts without opening the app.
 */
class TraceActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
        val action = intent.action ?: return
        val pending = goAsync()
        Thread {
            try {
                val wanted = if (action == TraceMessagingService.ACTION_ACCEPT) "accept" else "reject"
                TraceApi.respond(requestId, wanted)
                if (wanted == "accept") {
                    BatteryAccess.markPromptPending(context)
                    val item = TraceApi.openRequests().firstOrNull { it.id == requestId }
                    val expiresMs = item?.expiresAt?.let { parseIsoMillis(it) } ?: 0L
                    if (expiresMs > System.currentTimeMillis()) {
                        TraceSharingService.start(context, requestId, expiresMs)
                    }
                }
            } catch (_: Exception) {
                // The request may have expired or been cancelled. The Settings card shows the real state.
            } finally {
                context.getSystemService(NotificationManager::class.java)
                    .cancel(TraceMessagingService.notificationId(requestId))
                pending.finish()
            }
        }.start()
    }

    private fun parseIsoMillis(value: String): Long? =
        runCatching { java.time.OffsetDateTime.parse(value).toInstant().toEpochMilli() }.getOrNull()

    companion object {
        const val EXTRA_REQUEST_ID = "request_id"
    }
}

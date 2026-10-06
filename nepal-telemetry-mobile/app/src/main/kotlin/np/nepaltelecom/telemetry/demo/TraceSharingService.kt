package np.nepaltelecom.telemetry.demo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.model.Sample
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Shares this phone's location and signal with NTC while an operator trace is
 * accepted (2026-10-05). It runs as a foreground service with a visible
 * notification and a Stop action. Every [INTERVAL_MS] it reads the live cell
 * and location and posts one signed fix to the trace. It stops when the trace
 * expires, when the user taps Stop, or when the server ends the trace.
 */
class TraceSharingService : Service() {

    @Volatile private var running = false
    private var traceId: String? = null
    private var expiresAtMs: Long = 0L
    private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSharing(tellServer = true)
            return START_NOT_STICKY
        }
        val id = intent?.getStringExtra(EXTRA_TRACE_ID) ?: return START_NOT_STICKY
        val expires = intent.getLongExtra(EXTRA_EXPIRES_MS, 0L)
        if (running && id == traceId) return START_STICKY

        traceId = id
        expiresAtMs = expires
        ensureChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        running = true
        worker = Thread { loop() }.apply { start() }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun loop() {
        while (running) {
            if (System.currentTimeMillis() >= expiresAtMs) {
                stopSharing(tellServer = false)
                return
            }
            sampleAndSend()
            try {
                Thread.sleep(INTERVAL_MS)
            } catch (_: InterruptedException) {
                return
            }
        }
    }

    /** One fix. A failed read or post is skipped, and the next tick tries again. */
    private fun sampleAndSend() {
        val id = traceId ?: return
        val latch = CountDownLatch(1)
        var sample: Sample? = null
        NetTelemetry.readLiveSample {
            sample = it
            latch.countDown()
        }
        latch.await(READ_TIMEOUT_S, TimeUnit.SECONDS)
        val s = sample ?: return
        val lat = s.lat ?: return
        val lon = s.lon ?: return

        val item = JSONObject()
            .put("ts", System.currentTimeMillis())
            .put("lat", lat)
            .put("lon", lon)
        s.gpsAccuracyM?.let { item.put("accuracy_m", it.toDouble()) }
        item.put("network_type", s.networkType)
        s.cellId?.let { item.put("cell_id", it) }
        s.pci?.let { item.put("pci", it) }
        s.tac?.let { item.put("tac", it) }
        s.mcc?.let { item.put("mcc", it) }
        s.mnc?.let { item.put("mnc", it) }
        s.rsrpDbm?.let { item.put("rsrp_dbm", it) }
        s.rsrqDb?.let { item.put("rsrq_db", it) }
        s.sinrDb?.let { item.put("sinr_db", it) }
        s.rssiDbm?.let { item.put("rssi_dbm", it) }
        s.cqi?.let { item.put("cqi", it) }

        try {
            TraceApi.postSamples(id, JSONArray().put(item))
        } catch (e: TraceApi.ApiException) {
            // 404 or 409: the server no longer takes fixes for this trace (cancelled, expired, or ended).
            if (e.code == 404 || e.code == 409) stopSharing(tellServer = false)
        } catch (_: Exception) {
            // Network or other failure: the next tick sends the next fix.
        }
    }

    private fun stopSharing(tellServer: Boolean) {
        running = false
        val id = traceId
        if (tellServer && id != null) {
            runCatching { TraceApi.respond(id, "stop") }
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.trace_channel), NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, TraceSharingService::class.java).setAction(ACTION_STOP)
        val stopPending = PendingIntent.getService(
            this, 0, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val until = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(expiresAtMs))
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(getString(R.string.trace_sharing_title))
            .setContentText(getString(R.string.trace_sharing_until, until))
            .setOngoing(true)
            .addAction(0, getString(R.string.trace_sharing_stop), stopPending)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "trace_sharing"
        private const val NOTIFICATION_ID = 4107
        private const val INTERVAL_MS = 10_000L
        private const val READ_TIMEOUT_S = 20L
        const val ACTION_STOP = "np.nepaltelecom.telemetry.demo.TRACE_STOP"
        private const val EXTRA_TRACE_ID = "trace_id"
        private const val EXTRA_EXPIRES_MS = "expires_ms"

        /** Starts sharing for [traceId] until [expiresAtMs]. Safe to call again for the same trace. */
        fun start(context: Context, traceId: String, expiresAtMs: Long) {
            val intent = Intent(context, TraceSharingService::class.java)
                .putExtra(EXTRA_TRACE_ID, traceId)
                .putExtra(EXTRA_EXPIRES_MS, expiresAtMs)
            context.startForegroundService(intent)
        }

        /** Ends sharing and tells the server to stop the trace. */
        fun stop(context: Context) {
            context.startService(Intent(context, TraceSharingService::class.java).setAction(ACTION_STOP))
        }
    }
}

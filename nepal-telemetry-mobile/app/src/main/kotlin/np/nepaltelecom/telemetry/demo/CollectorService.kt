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
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.device.SpeedTest

/**
 * Collector edition only (2026-10-14). While sharing is on, takes one reading
 * every [SAMPLE_INTERVAL_MS] and sends what is queued every
 * [UPLOAD_INTERVAL_MS], and runs a speed test every [SPEED_INTERVAL_MS] on
 * mobile data, with a visible notification and a Stop action. The
 * readings carry the share's session, as any other shared reading does. It
 * ends itself as soon as sharing is off, however that happened.
 */
class CollectorService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var lastUploadAtMs = 0L

    private val tick = object : Runnable {
        override fun run() {
            if (!NetTelemetry.isOptedIn()) {
                stopSelf()
                return
            }
            NetTelemetry.sampleNow()
            val now = System.currentTimeMillis()
            if (now - lastUploadAtMs >= UPLOAD_INTERVAL_MS) {
                lastUploadAtMs = now
                NetTelemetry.uploadNow()
            }
            if (now >= nextSpeedAtMs && !speedRunning) {
                nextSpeedAtMs = now + SPEED_INTERVAL_MS
                if (batteryAllowsSpeedTest()) runSpeedTest()
            }
            handler.postDelayed(this, SAMPLE_INTERVAL_MS)
        }
    }

    @Volatile private var speedRunning = false
    private var nextSpeedAtMs = 0L

    /**
     * One speed test (the same one as the Signal screen's card), reported with
     * the radio state read just before it. On the server it sits next to this
     * phone's readings of the same minutes, which carry the position. It goes
     * over mobile data even while the phone is on Wi-Fi, and is skipped when
     * mobile data is off: a Wi-Fi result says nothing about NTC's network.
     */
    private fun runSpeedTest() {
        speedRunning = true
        Thread {
            try {
                val latch = java.util.concurrent.CountDownLatch(1)
                var radio: np.nepaltelecom.telemetry.model.Sample? = null
                NetTelemetry.readLiveCell { radio = it; latch.countDown() }
                latch.await(10, java.util.concurrent.TimeUnit.SECONDS)
                val r = SpeedTest.runOnMobileData(this, fallback = false, profile = SpeedTest.Profile.LIGHT)
                if (r != null && r.error == null) {
                    val s = radio
                    NetTelemetry.reportSpeedTest(
                        pingMedianMs = r.pingMedianMs, jitterMs = r.jitterMs,
                        downloadMbps = r.downloadMbps, uploadMbps = r.uploadMbps,
                        networkType = s?.networkType, rsrpDbm = s?.rsrpDbm ?: s?.rscpDbm ?: s?.rssiDbm,
                        packetLossPct = r.packetLossPct,
                        bearer = r.bearer,
                        latencyDownMs = r.latencyDownMs, latencyUpMs = r.latencyUpMs,
                    )
                }
            } finally {
                speedRunning = false
            }
        }.start()
    }

    /** No speed test below [SPEED_MIN_BATTERY_PCT] unless the phone is charging. */
    private fun batteryAllowsSpeedTest(): Boolean {
        val bm = getSystemService(android.os.BatteryManager::class.java) ?: return true
        return bm.isCharging || bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY) >= SPEED_MIN_BATTERY_PCT
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            NetTelemetry.stopShare()
            stopSelf()
            return START_NOT_STICKY
        }
        ensureChannel()
        val notification = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (_: Exception) {
            // Android refuses a location service started from the background
            // (after a restart). Opening the app starts it again.
            stopSelf()
            return START_NOT_STICKY
        }
        handler.removeCallbacks(tick)
        // A first upload a minute in, then every UPLOAD_INTERVAL_MS.
        lastUploadAtMs = System.currentTimeMillis() - UPLOAD_INTERVAL_MS + 60_000L
        nextSpeedAtMs = System.currentTimeMillis() + SPEED_FIRST_AFTER_MS
        handler.post(tick)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        super.onDestroy()
    }

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.collector_channel), NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    private fun buildNotification(): Notification {
        val stopPending = PendingIntent.getService(
            this, 0, Intent(this, CollectorService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val openPending = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(getString(R.string.collector_title))
            .setContentText(getString(R.string.collector_text))
            .setContentIntent(openPending)
            .setOngoing(true)
            .addAction(0, getString(R.string.trace_sharing_stop), stopPending)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "collector_sharing"
        private const val NOTIFICATION_ID = 4108
        private const val SAMPLE_INTERVAL_MS = 15_000L
        private const val UPLOAD_INTERVAL_MS = 5 * 60_000L
        // One speed test every 30 minutes on mobile data, the first about two
        // minutes after sharing starts. Each run moves about 8 MB (6 down, 2 up).
        private const val SPEED_INTERVAL_MS = 30 * 60_000L
        private const val SPEED_FIRST_AFTER_MS = 2 * 60_000L
        private const val SPEED_MIN_BATTERY_PCT = 20
        private const val ACTION_STOP = "np.nepaltelecom.telemetry.demo.COLLECTOR_STOP"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, CollectorService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CollectorService::class.java))
        }
    }
}

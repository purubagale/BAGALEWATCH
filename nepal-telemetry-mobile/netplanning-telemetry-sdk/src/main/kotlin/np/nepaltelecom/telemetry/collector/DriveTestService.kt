package np.nepaltelecom.telemetry.collector

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import np.nepaltelecom.telemetry.storage.DeviceIdentity
import np.nepaltelecom.telemetry.storage.SampleQueue

/**
 * Drive-test tracking (2026-10-04). While this service runs it asks for a
 * location fix every [FIX_INTERVAL_MS], so the route is continuous rather than
 * a scatter of one-off samples. Each fix at or under [MAX_TRACK_ACCURACY_M]
 * becomes a Sample in the normal upload queue.
 *
 * It runs as a foreground service with a persistent notification and a Stop
 * action. It only runs when started through NetTelemetry.startDriveTest(),
 * which checks the device's opt-in first.
 */
class DriveTestService : Service() {

    private var fused: FusedLocationProviderClient? = null
    private var callback: LocationCallback? = null
    private val scope = CoroutineScope(Dispatchers.Default)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopTracking()
        } else {
            startTracking()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopLocationUpdates()
        super.onDestroy()
    }

    private fun startTracking() {
        if (callback != null) return
        ensureChannel()
        // Must run within a few seconds of startForegroundService(), so do it
        // before anything else. The location type is required on Android 14+.
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
        )

        val client = LocationServices.getFusedLocationProviderClient(this)
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, FIX_INTERVAL_MS).build()
        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.lastLocation?.let { onFix(it) }
            }
        }
        fused = client
        callback = cb
        try {
            client.requestLocationUpdates(request, cb, Looper.getMainLooper())
        } catch (e: SecurityException) {
            // Location permission was revoked after the user started the test.
            stopTracking()
        }
    }

    private fun onFix(location: Location) {
        if (!location.hasAccuracy() || location.accuracy > MAX_TRACK_ACCURACY_M) return
        scope.launch {
            // Cell state is read on a background thread, off the location callback.
            val sample = CellSampleCollector(this@DriveTestService, DeviceIdentity(this@DriveTestService))
                .sampleFrom(location, triggerReason = TRIGGER_REASON)
            sample?.let { SampleQueue(this@DriveTestService).append(it) }
        }
    }

    private fun stopLocationUpdates() {
        val cb = callback
        if (cb != null) fused?.removeLocationUpdates(cb)
        callback = null
    }

    private fun stopTracking() {
        stopLocationUpdates()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Drive test tracking", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    private fun buildNotification(): Notification {
        val stopIntent = PendingIntent.getService(
            this,
            0,
            Intent(this, DriveTestService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Drive test running")
            .setContentText("Location is being recorded for a network drive test. Tap Stop to end it.")
            .setOngoing(true)
            .addAction(0, "Stop", stopIntent)
            .build()
    }

    companion object {
        /** Intent action that ends tracking. Sent by the notification's Stop button. */
        const val ACTION_STOP = "np.nepaltelecom.telemetry.DRIVE_TEST_STOP"

        private const val CHANNEL_ID = "netplanning_drive_test"
        private const val NOTIFICATION_ID = 4201
        private const val FIX_INTERVAL_MS = 2_000L
        private const val MAX_TRACK_ACCURACY_M = 30f

        // Tracked fixes are stored as "manual" samples. The server only accepts
        // periodic, handover, or manual for now.
        private const val TRIGGER_REASON = "manual"
    }
}

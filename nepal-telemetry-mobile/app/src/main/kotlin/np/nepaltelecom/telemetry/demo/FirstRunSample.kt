package np.nepaltelecom.telemetry.demo

import android.content.Context
import android.os.Handler
import android.os.Looper
import np.nepaltelecom.telemetry.NetTelemetry

/**
 * The one-minute sample sent when location is allowed on the setup screen
 * (2026-10-13): at first install, after an update, or whenever the screen
 * had to ask because the permission was missing. The app shares for about a
 * minute, so the server gets a few readings from the phone, and then
 * switches sharing off by itself. The setup screen says so before the user
 * allows anything. After that, sharing is off until the user turns it on.
 *
 * It is a normal share window with a one-minute cap, so the SDK's own expiry
 * alarm ends it even if the app is closed before the minute is up. The timer
 * here only takes the readings and ends it on time while the app stays open.
 */
object FirstRunSample {

    private const val WINDOW_MINUTES = 1
    private val READ_AT_MS = listOf(3_000L, 20_000L, 40_000L, 55_000L)
    private const val END_AT_MS = 60_000L

    fun start(context: Context) {
        // Collector edition: allowing location starts the open-ended share instead.
        if (Collector.enabled) {
            Collector.startSharing(context)
            return
        }
        val endsAt = NetTelemetry.startShare(WINDOW_MINUTES)
        val handler = Handler(Looper.getMainLooper())
        // Still this window? The user may have stopped it, or started their own, in the meantime.
        fun stillOurs() = NetTelemetry.shareExpiresAtMs() == endsAt
        READ_AT_MS.forEach { at -> handler.postDelayed({ if (stillOurs()) NetTelemetry.sampleNow() }, at) }
        handler.postDelayed({ if (stillOurs()) NetTelemetry.stopShare() }, END_AT_MS)
    }
}

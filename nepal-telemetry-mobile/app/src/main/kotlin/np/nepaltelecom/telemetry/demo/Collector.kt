package np.nepaltelecom.telemetry.demo

import android.content.Context
import np.nepaltelecom.telemetry.NetTelemetry

/**
 * The collector edition (2026-10-14), for a small group of staff gathering
 * test data. In it, sharing has no time limit: it runs until the user taps
 * Stop sharing in Settings or Stop on the notification, and [CollectorService]
 * takes a reading every 15 seconds and a speed test every 30 minutes on
 * mobile data while it runs. In the standard edition this
 * object only passes the normal one-hour share through.
 */
object Collector {

    val enabled: Boolean = BuildConfig.COLLECTOR

    /** About ten years: in practice no end, but still an ordinary share window. */
    private const val NO_LIMIT_MINUTES = 10 * 365 * 24 * 60

    /** Starts sharing: the normal window, or the open-ended one with its reading service. */
    fun startSharing(context: Context) {
        if (!enabled) {
            NetTelemetry.startShare()
            return
        }
        NetTelemetry.startShare(NO_LIMIT_MINUTES)
        CollectorService.start(context)
        // Readings every minute need the phone not to put the app to sleep.
        if (!BatteryAccess.isUnrestricted(context)) BatteryAccess.markPromptPending(context)
    }

    fun stopSharing(context: Context) {
        NetTelemetry.stopShare()
        if (enabled) CollectorService.stop(context)
    }

    /** On app start: sharing is still on but the service was ended (restart, app killed). */
    fun resumeIfSharing(context: Context) {
        if (enabled && NetTelemetry.isOptedIn() && NetTelemetry.shareExpiresAtMs() != null) {
            runCatching { CollectorService.start(context) }
        }
    }
}

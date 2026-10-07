package np.nepaltelecom.telemetry.collector

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import np.nepaltelecom.telemetry.NetTelemetry

/** Fires when a share window's time is up, and ends the share (2026-10-07). */
class ShareExpiryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        NetTelemetry.onShareExpiryAlarm()
    }
}

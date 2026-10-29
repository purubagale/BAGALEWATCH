package np.nepaltelecom.telemetry.demo

import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import np.nepaltelecom.telemetry.NetTelemetry

/**
 * Asks once, on the first start after install or after an update, whether to
 * "Help improve NTC's network" (2026-10-29): four anonymous readings a day,
 * with no position. The answer can be changed in Settings at any time.
 * [then] runs after the answer, or at once when it was asked before.
 */
object NetworkHelpPrompt {

    fun askIfNeeded(activity: AppCompatActivity, then: () -> Unit) {
        if (NetTelemetry.scheduledReadingsAsked()) return then()
        AlertDialog.Builder(activity)
            .setTitle(R.string.network_help_title)
            .setMessage(R.string.network_help_body)
            .setCancelable(false)
            .setPositiveButton(R.string.network_help_yes) { _, _ -> NetTelemetry.setScheduledReadings(true); then() }
            .setNegativeButton(R.string.network_help_no) { _, _ -> NetTelemetry.setScheduledReadings(false); then() }
            .show()
    }
}

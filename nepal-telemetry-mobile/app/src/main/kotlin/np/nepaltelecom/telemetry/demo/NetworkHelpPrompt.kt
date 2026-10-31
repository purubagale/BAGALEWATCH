package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.collector.ScheduledReadings

/**
 * Asks once, on the first start after install or after an update, whether to
 * "Help improve NTC's network" (2026-10-29): four readings a day with no
 * number. After a yes it offers the optional rough area (about 500 m), which
 * needs location "Allow all the time" because the readings are taken while
 * the app is closed. Both can be changed in Settings at any time.
 * [then] runs after the answers, or at once when it was asked before.
 */
object NetworkHelpPrompt {

    private const val REQUEST_BACKGROUND = 4711

    fun askIfNeeded(activity: AppCompatActivity, then: () -> Unit) {
        if (NetTelemetry.scheduledReadingsAsked()) return then()
        AlertDialog.Builder(activity)
            .setTitle(R.string.network_help_title)
            .setMessage(R.string.network_help_body)
            .setCancelable(false)
            .setPositiveButton(R.string.network_help_yes) { _, _ ->
                NetTelemetry.setScheduledReadings(true)
                offerArea(activity, then)
            }
            .setNegativeButton(R.string.network_help_no) { _, _ -> NetTelemetry.setScheduledReadings(false); then() }
            .show()
    }

    /** The optional rough area: asks for location "Allow all the time" when it is not granted yet. */
    fun offerArea(activity: AppCompatActivity, then: () -> Unit = {}) {
        if (ScheduledReadings.hasBackgroundLocation(activity) || !hasForegroundLocation(activity) ||
            BackgroundLocation.askedJustNow()
        ) return then()
        AlertDialog.Builder(activity)
            .setTitle(R.string.network_area_title)
            .setMessage(R.string.network_area_body)
            .setPositiveButton(R.string.network_area_yes) { _, _ ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ActivityCompat.requestPermissions(
                        activity, arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), REQUEST_BACKGROUND,
                    )
                }
                then()
            }
            .setNegativeButton(R.string.network_area_no) { _, _ -> then() }
            .show()
    }

    private fun hasForegroundLocation(activity: AppCompatActivity) =
        ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
}

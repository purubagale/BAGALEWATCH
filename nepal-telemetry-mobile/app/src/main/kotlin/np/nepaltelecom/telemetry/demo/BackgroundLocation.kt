package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Location "Allow all the time" for shared readings (2026-10-30). Readings
 * taken while the app is closed (the periodic ones) get a GPS position from
 * Android only with this choice; without it they carry the network, level and
 * quality but no place. Offered when the user starts sharing, and from a
 * Settings button while it is missing. Never asked silently.
 */
object BackgroundLocation {

    private const val REQUEST = 4712

    fun has(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasForeground(context: Context) =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** Asks with a short explanation; does nothing when granted or when location itself is off-limits. */
    fun offer(activity: AppCompatActivity, then: () -> Unit = {}) {
        if (has(activity) || !hasForeground(activity)) return then()
        AlertDialog.Builder(activity)
            .setTitle(R.string.share_background_title)
            .setMessage(R.string.share_background_body)
            .setPositiveButton(R.string.share_background_yes) { _, _ ->
                ActivityCompat.requestPermissions(
                    activity, arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), REQUEST,
                )
                then()
            }
            .setNegativeButton(R.string.share_background_no) { _, _ -> then() }
            .show()
    }
}

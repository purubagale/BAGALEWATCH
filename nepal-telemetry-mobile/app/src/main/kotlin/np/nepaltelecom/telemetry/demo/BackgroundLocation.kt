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
 * quality but no place. Asked with the other permissions on the first start
 * after install or update (2026-10-31); again only when it is still missing,
 * when the user starts sharing, or from a Settings button. Never asked silently.
 */
object BackgroundLocation {

    private const val REQUEST = 4712

    /** When it was last asked in this run, so two questions do not follow each other. */
    @Volatile private var askedAtMs = 0L

    fun askedJustNow(): Boolean = System.currentTimeMillis() - askedAtMs < 5 * 60_000L

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
        askedAtMs = System.currentTimeMillis()
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

package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import androidx.core.content.ContextCompat

/**
 * Checks, inside the app, for the settings that stop a phone reporting cells
 * (2026-10-04). Each check has a fix the user can make on their own phone, so
 * the app can guide them without anyone else touching the device.
 */
object PhoneChecks {

    enum class Problem { PERMISSION_MISSING, LOCATION_SERVICES_OFF, HIGH_ACCURACY_OFF }

    fun problems(context: Context): List<Problem> {
        val found = mutableListOf<Problem>()
        val fine = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        if (!fine) found.add(Problem.PERMISSION_MISSING)

        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val gps = runCatching { manager.isProviderEnabled(LocationManager.GPS_PROVIDER) }.getOrDefault(false)
        val network = runCatching { manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) }.getOrDefault(false)
        when {
            !gps && !network -> found.add(Problem.LOCATION_SERVICES_OFF)
            !gps -> found.add(Problem.HIGH_ACCURACY_OFF)
        }
        return found
    }
}

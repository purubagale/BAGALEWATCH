package np.nepaltelecom.telemetry.demo

import android.content.Context
import np.nepaltelecom.telemetry.device.NetDevice

/**
 * Registering this phone with its mobile number (2026-10-13). Two screens
 * start it: the pop-up shown after first-run setup or after an update, and
 * the form in Settings. The work itself, with its background retry, is in
 * the SDK ([NetDevice], since 2026-10-16); this adds the app's wording and
 * the user type from the employee tick box.
 *
 * "Registered" is what this phone remembers. It survives an app update and
 * is lost with the phone's key when the app is uninstalled.
 */
object Registration {

    fun isRegistered(context: Context): Boolean = NetDevice.isRegistered(context)

    /** The number typed at registration, or "" when none was. */
    fun number(context: Context): String = NetDevice.number(context)

    /** [onDone] runs on the main thread with whether the first try worked and a message to show. */
    fun register(context: Context, msisdn: String, onDone: (Boolean, String) -> Unit) {
        val app = context.applicationContext
        val userType = if (StaffMode.isEmployee(app)) "employee" else "general"
        NetDevice.register(app, msisdn, userType) { ok, error ->
            onDone(
                ok,
                if (ok) app.getString(R.string.req_registered_as, msisdn)
                else app.getString(R.string.req_failed_retrying, error.orEmpty()),
            )
        }
    }
}

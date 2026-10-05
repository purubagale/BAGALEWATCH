package np.nepaltelecom.telemetry.demo

import android.content.Context

/**
 * The "I am an NTC employee" choice (2026-10-05). Until the NTC app's login
 * is connected, this box is the only source of staff status, so it is stored
 * as a self-declared value. While it's off, only Settings is usable. When it's
 * on, the other tabs open. Staff status is never used to decide who can see
 * operator data. The server enforces that by role.
 */
object StaffMode {
    private const val PREFS = "dtwatch_staff"
    private const val KEY_EMPLOYEE = "is_employee"

    fun isEmployee(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_EMPLOYEE, false)

    fun setEmployee(context: Context, value: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_EMPLOYEE, value)
            .apply()
    }
}

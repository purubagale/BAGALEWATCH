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
    private const val KEY_DRIVE_SHARE = "drive_share_answer"

    fun isEmployee(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_EMPLOYEE, false)

    fun setEmployee(context: Context, value: Boolean) {
        val edit = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_EMPLOYEE, value)
        // A remembered sharing answer is offered to employees only, so it goes with the box.
        if (!value) edit.remove(KEY_DRIVE_SHARE)
        edit.apply()
    }

    /**
     * The employee's remembered answer to "Share this drive with NTC?"
     * (2026-10-12), or null when they are asked each time. Everyone else is
     * always asked.
     */
    fun rememberedDriveShare(context: Context): Boolean? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return if (isEmployee(context) && prefs.contains(KEY_DRIVE_SHARE)) prefs.getBoolean(KEY_DRIVE_SHARE, true) else null
    }

    fun setRememberedDriveShare(context: Context, value: Boolean?) {
        val edit = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        if (value == null) edit.remove(KEY_DRIVE_SHARE) else edit.putBoolean(KEY_DRIVE_SHARE, value)
        edit.apply()
    }
}

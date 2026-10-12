package np.nepaltelecom.telemetry.collector

import android.content.Context

/**
 * Two small facts about sharing that have to outlive the process (2026-10-12).
 *
 * [autoOptIn]: sharing was switched on only for the drive test now running,
 * because the user agreed to share that drive. It is switched off again when
 * the drive stops. False when the user was already sharing before the drive
 * started: then stopping the drive leaves sharing alone.
 *
 * [drainPending]: sharing has been switched off, but readings recorded while
 * the user had agreed are still waiting to be sent, for example because the
 * server could not be reached. The uploader may send what is queued and
 * nothing new is collected. Cleared when the queue is empty, and when the
 * user opts out with the queue wiped.
 */
internal object DriveShare {
    private const val PREFS = "netplanning_drive_share"
    private const val KEY_AUTO = "auto_opt_in"
    private const val KEY_DRAIN = "drain_pending"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun autoOptIn(context: Context): Boolean = prefs(context).getBoolean(KEY_AUTO, false)

    fun setAutoOptIn(context: Context, value: Boolean) {
        prefs(context).edit().putBoolean(KEY_AUTO, value).apply()
    }

    fun drainPending(context: Context): Boolean = prefs(context).getBoolean(KEY_DRAIN, false)

    fun setDrainPending(context: Context, value: Boolean) {
        prefs(context).edit().putBoolean(KEY_DRAIN, value).apply()
    }
}

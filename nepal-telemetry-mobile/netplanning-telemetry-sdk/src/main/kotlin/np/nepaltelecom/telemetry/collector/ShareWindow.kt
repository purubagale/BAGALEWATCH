package np.nepaltelecom.telemetry.collector

import android.content.Context

/**
 * The time window of one "share with NTC" session (2026-10-07). It holds the
 * session ID that tags every sample taken during the window, and when the
 * window ends. Stored on the phone, so a restart keeps the same window.
 */
internal object ShareWindow {
    private const val PREFS = "netplanning_share"
    private const val KEY_ID = "session_id"
    private const val KEY_EXPIRES_MS = "expires_ms"

    fun start(context: Context, sessionId: String, expiresAtMs: Long) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_ID, sessionId)
            .putLong(KEY_EXPIRES_MS, expiresAtMs)
            .apply()
    }

    /** The session ID while the window is open, or null once it has ended or never started. */
    fun currentSessionId(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val id = prefs.getString(KEY_ID, null) ?: return null
        return if (System.currentTimeMillis() < prefs.getLong(KEY_EXPIRES_MS, 0L)) id else null
    }

    /** The last session ID, even after its window has ended. Used for the stop marker. */
    fun storedSessionId(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ID, null)

    /** When the window ends, in epoch ms. 0 if none has been started. */
    fun expiresAtMs(context: Context): Long =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_EXPIRES_MS, 0L)

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }
}

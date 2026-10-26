package np.nepaltelecom.telemetry.storage

import android.content.Context
import org.json.JSONArray

/**
 * Speed-test results waiting to be sent (2026-10-26). A result used to be
 * sent once and dropped when DT-WATCH could not be reached (on mobile data
 * the server is not reachable yet), so the test was lost. Each entry is the
 * JSON body as sent, with the time of the test in it. A JSON array in
 * private preferences, like [CallQueue]; at most [MAX_RESULTS], oldest
 * dropped first.
 */
internal class SpeedResultQueue(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun append(body: String) {
        val all = read().toMutableList()
        all.add(body)
        write(all.takeLast(MAX_RESULTS))
    }

    @Synchronized
    fun peek(max: Int): List<String> = read().take(max)

    /** Removes the first [count] results, the ones [peek] returned and the server took. */
    @Synchronized
    fun removeFirst(count: Int) = write(read().drop(count))

    @Synchronized
    fun clear() = prefs.edit().remove(KEY).apply()

    private fun read(): List<String> {
        val raw = prefs.getString(KEY, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { arr.getString(it) }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun write(items: List<String>) {
        prefs.edit().putString(KEY, JSONArray(items).toString()).apply()
    }

    private companion object {
        const val PREFS = "netplanning_speed_results"
        const val KEY = "queue"
        const val MAX_RESULTS = 100
    }
}

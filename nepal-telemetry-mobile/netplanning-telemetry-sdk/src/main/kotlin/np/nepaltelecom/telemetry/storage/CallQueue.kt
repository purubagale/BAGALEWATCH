package np.nepaltelecom.telemetry.storage

import android.content.Context
import np.nepaltelecom.telemetry.model.CallRecord
import org.json.JSONArray

/**
 * Finished calls waiting to be sent (2026-10-14). Small and rare compared
 * with signal samples, so a JSON array in private preferences is enough.
 * Keeps at most [MAX_CALLS]; the oldest go first when full.
 */
internal class CallQueue(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun append(record: CallRecord) {
        val all = read().toMutableList()
        all.add(record)
        write(all.takeLast(MAX_CALLS))
    }

    @Synchronized
    fun peek(max: Int): List<CallRecord> = read().take(max)

    /** Removes the first [count] calls, the ones [peek] returned and the server accepted. */
    @Synchronized
    fun removeFirst(count: Int) = write(read().drop(count))

    @Synchronized
    fun clear() = prefs.edit().remove(KEY).apply()

    private fun read(): List<CallRecord> {
        val raw = prefs.getString(KEY, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                runCatching { CallRecord.fromJson(arr.getJSONObject(i)) }.getOrNull()
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun write(records: List<CallRecord>) {
        prefs.edit().putString(KEY, JSONArray(records.map { it.toJson() }).toString()).apply()
    }

    private companion object {
        const val PREFS = "netplanning_calls"
        const val KEY = "queue"
        const val MAX_CALLS = 200
    }
}

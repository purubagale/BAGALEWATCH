package np.nepaltelecom.telemetry.storage

import android.content.Context
import android.content.SharedPreferences
import np.nepaltelecom.telemetry.model.Sample
import org.json.JSONObject
import java.io.File
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * A plain append-only JSONL file as the local offline queue -- one JSON
 * object per line. No SQLite/Room dependency: at pilot scale (one device,
 * capped backlog, flushed every upload cycle) a flat file is enough, is easy
 * to inspect by hand during the pilot, and mirrors the same "simple file
 * store first, real database only once it needs to scale" choice the earlier
 * beacon prototype made deliberately, for the same reason.
 *
 * Every public method is synchronized on [lock] -- WorkManager's upload
 * worker and the collector's periodic/handover callbacks can both touch this
 * from different threads. The lock and the line count are shared by every
 * instance in the process (audit 2026-10-23): callers create a new
 * SampleQueue each time, and a lock per instance did not stop two of them
 * from writing the file at once.
 *
 * Appending no longer reads the file. The queued lines are counted once per
 * process and the count is then kept; the file is trimmed back to
 * [MAX_QUEUED_SAMPLES] only once it is [TRIM_SLACK] lines over. Before, every
 * new reading re-read the whole queue (up to 5,000 lines, 2-3 MB) to check
 * its size -- a fix every 2 s during a drive test.
 */
internal class SampleQueue(
    private val file: File,
    // A tiny separate prefs value for "when was the last sample taken", kept
    // independent of the queue file: a sample's row disappears from the queue
    // the moment it uploads successfully, but a status display (the host
    // app's own "last checked: 2 min ago") should still be able to answer
    // that question even when the queue is currently empty. Null in unit tests.
    private val statePrefs: SharedPreferences?,
) {

    constructor(context: Context) : this(
        File(context.filesDir, "netplanning_telemetry_queue.jsonl"),
        context.getSharedPreferences("netplanning_telemetry_state", Context.MODE_PRIVATE),
    )

    companion object {
        // A misbehaving handset or a long offline stretch shouldn't be able to
        // grow this file without bound -- drop the oldest samples first.
        const val MAX_QUEUED_SAMPLES = 5_000
        // Lines allowed over the cap before the file is rewritten.
        const val TRIM_SLACK = 500
        private const val KEY_LAST_SAMPLE_AT_MS = "last_sample_at_ms"

        private val lock = ReentrantLock()
        // Lines in each queue file, counted once per process (one file in the
        // app; kept per path so tests on separate files do not mix).
        private val counts = HashMap<String, Int>()
    }

    private var count: Int
        get() = counts[file.path] ?: -1
        set(value) { counts[file.path] = value }

    fun append(sample: Sample) = lock.withLock {
        val before = knownCount()
        file.appendText(sample.toJson().toString() + "\n")
        count = before + 1
        statePrefs?.edit()?.putLong(KEY_LAST_SAMPLE_AT_MS, sample.timestampMs)?.apply()
        if (count > MAX_QUEUED_SAMPLES + TRIM_SLACK) trim()
    }

    /** When the most recent sample was taken, independent of whether it has uploaded/been removed yet. */
    fun lastSampleAtMs(): Long? =
        statePrefs?.getLong(KEY_LAST_SAMPLE_AT_MS, -1L)?.takeIf { it >= 0 }

    fun size(): Int = lock.withLock { knownCount() }

    /** Returns up to [limit] queued samples, oldest first (FIFO upload order), without removing them. */
    fun peek(limit: Int): List<Sample> = lock.withLock {
        if (!file.exists()) return@withLock emptyList()
        // Reads only as far as the first [limit] lines.
        file.useLines { lines -> lines.filter { it.isNotBlank() }.take(limit).toList() }
            .mapNotNull { parseLine(it) }
    }

    /**
     * Removes exactly the given samples (matched by device ID + timestamp,
     * which together are unique per sample) after a confirmed successful
     * upload. Anything not in [uploaded] -- because the upload failed
     * partway, or new samples arrived mid-flush -- stays queued.
     */
    fun remove(uploaded: List<Sample>) = lock.withLock {
        if (uploaded.isEmpty()) return@withLock
        val uploadedKeys = uploaded.map { it.deviceId to it.timestampMs }.toSet()
        val remaining = readAllLines().filter { line ->
            val s = parseLine(line) ?: return@filter true // keep anything unparseable rather than silently drop it
            (s.deviceId to s.timestampMs) !in uploadedKeys
        }
        file.writeText(remaining.joinToString("\n", postfix = if (remaining.isEmpty()) "" else "\n"))
        count = remaining.size
    }

    fun clear() = lock.withLock {
        file.writeText("")
        count = 0
    }

    private fun knownCount(): Int {
        if (count < 0) count = if (file.exists()) file.useLines { lines -> lines.count { it.isNotBlank() } } else 0
        return count
    }

    private fun trim() {
        val trimmed = readAllLines().takeLast(MAX_QUEUED_SAMPLES)
        file.writeText(trimmed.joinToString("\n", postfix = "\n"))
        count = trimmed.size
    }

    private fun readAllLines(): List<String> =
        if (file.exists()) file.readLines().filter { it.isNotBlank() } else emptyList()

    private fun parseLine(line: String): Sample? = try {
        Sample.fromJson(JSONObject(line))
    } catch (e: Exception) {
        null // one corrupt line (e.g. a partial write after a crash) shouldn't take down the whole queue
    }
}

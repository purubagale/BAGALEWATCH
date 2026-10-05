package np.nepaltelecom.telemetry.storage

import android.content.Context
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
 * from different threads.
 */
internal class SampleQueue(context: Context) {

    private val file = File(context.filesDir, "netplanning_telemetry_queue.jsonl")
    // A tiny separate prefs value for "when was the last sample taken", kept
    // independent of the queue file: a sample's row disappears from the queue
    // the moment it uploads successfully, but a status display (the host
    // app's own "last checked: 2 min ago") should still be able to answer
    // that question even when the queue is currently empty.
    private val statePrefs = context.getSharedPreferences("netplanning_telemetry_state", Context.MODE_PRIVATE)
    private val lock = ReentrantLock()

    companion object {
        // A misbehaving handset or a long offline stretch shouldn't be able to
        // grow this file without bound -- drop the oldest samples first.
        const val MAX_QUEUED_SAMPLES = 5_000
        private const val KEY_LAST_SAMPLE_AT_MS = "last_sample_at_ms"
    }

    fun append(sample: Sample) = lock.withLock {
        file.appendText(sample.toJson().toString() + "\n")
        statePrefs.edit().putLong(KEY_LAST_SAMPLE_AT_MS, sample.timestampMs).apply()
        trimIfNeeded()
    }

    /** When the most recent sample was taken, independent of whether it has uploaded/been removed yet. */
    fun lastSampleAtMs(): Long? =
        statePrefs.getLong(KEY_LAST_SAMPLE_AT_MS, -1L).takeIf { it >= 0 }

    fun size(): Int = lock.withLock { readAllLines().size }

    /** Returns up to [limit] queued samples, oldest first (FIFO upload order), without removing them. */
    fun peek(limit: Int): List<Sample> = lock.withLock {
        readAllLines().take(limit).mapNotNull { parseLine(it) }
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
    }

    fun clear() = lock.withLock { file.writeText("") }

    private fun trimIfNeeded() {
        val lines = readAllLines()
        if (lines.size > MAX_QUEUED_SAMPLES) {
            val trimmed = lines.takeLast(MAX_QUEUED_SAMPLES)
            file.writeText(trimmed.joinToString("\n", postfix = "\n"))
        }
    }

    private fun readAllLines(): List<String> =
        if (file.exists()) file.readLines().filter { it.isNotBlank() } else emptyList()

    private fun parseLine(line: String): Sample? = try {
        Sample.fromJson(JSONObject(line))
    } catch (e: Exception) {
        null // one corrupt line (e.g. a partial write after a crash) shouldn't take down the whole queue
    }
}

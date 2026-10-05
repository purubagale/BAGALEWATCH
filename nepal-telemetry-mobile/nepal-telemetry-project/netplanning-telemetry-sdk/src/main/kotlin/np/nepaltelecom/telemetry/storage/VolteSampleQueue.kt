package np.nepaltelecom.telemetry.storage

import android.content.Context
import np.nepaltelecom.telemetry.model.VolteSample
import org.json.JSONObject
import java.io.File
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Same flat-JSONL-file approach as [SampleQueue], for the same reasons (see
 * that class's doc) -- kept as a fully separate file/queue rather than
 * sharing storage with RF samples, since VoLTE samples upload on their own
 * per-call trigger (see VolteUploadWorker), not RF's periodic schedule.
 */
internal class VolteSampleQueue(context: Context) {
    private val file = File(context.filesDir, "netplanning_telemetry_volte_queue.jsonl")
    private val lock = ReentrantLock()

    companion object {
        // One sample per completed call -- a much lower natural volume than
        // RF's periodic/handover samples, but still capped in case of a long
        // offline stretch with many calls.
        const val MAX_QUEUED_SAMPLES = 1_000
    }

    fun append(sample: VolteSample) = lock.withLock {
        file.appendText(sample.toJson().toString() + "\n")
        trimIfNeeded()
    }

    fun size(): Int = lock.withLock { readAllLines().size }

    /** Returns up to [limit] queued samples, oldest first, without removing them. */
    fun peek(limit: Int): List<VolteSample> = lock.withLock {
        readAllLines().take(limit).mapNotNull { parseLine(it) }
    }

    /** Removes exactly the given samples (matched by device ID + timestamp) after a confirmed successful upload. */
    fun remove(uploaded: List<VolteSample>) = lock.withLock {
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

    private fun parseLine(line: String): VolteSample? = try {
        VolteSample.fromJson(JSONObject(line))
    } catch (e: Exception) {
        null // one corrupt line shouldn't take down the whole queue
    }
}

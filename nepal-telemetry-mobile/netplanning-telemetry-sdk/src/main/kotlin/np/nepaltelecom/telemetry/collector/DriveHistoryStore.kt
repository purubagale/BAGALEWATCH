package np.nepaltelecom.telemetry.collector

import android.content.Context
import np.nepaltelecom.telemetry.model.DriveSession
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * On-phone history of drive tests (2026-10-04). Each drive has its own file of
 * fixes, and one index file holds every drive's summary, so the list never
 * has to parse every route.
 *
 * Kept on the phone only. Nothing here is uploaded: the upload queue gets its
 * own copy of each fix as a Sample. Capped at [MAX_SESSIONS] drives, and each
 * drive keeps its most recent [MAX_POINTS] fixes.
 */
internal class DriveHistoryStore(context: Context) {

    private val dir = File(context.filesDir, "drive_history")
    private val indexFile = File(dir, "index.json")

    private data class Entry(
        val id: String,
        val startMs: Long,
        val endMs: Long?,
        val fixCount: Int,
        val distanceM: Double,
    )

    @Synchronized
    fun begin(id: String, startMs: Long) {
        dir.mkdirs()
        val entries = readIndex().toMutableList()
        entries.add(0, Entry(id, startMs, null, 0, 0.0))
        while (entries.size > MAX_SESSIONS) {
            val dropped = entries.removeAt(entries.lastIndex)
            fileFor(dropped.id).delete()
        }
        writeIndex(entries)
        writePoints(id, emptyList())
    }

    @Synchronized
    fun addPoints(id: String, added: List<RouteTrail.Point>) {
        if (added.isEmpty()) return
        val all = (readPoints(id) + added).let {
            if (it.size > MAX_POINTS) it.subList(it.size - MAX_POINTS, it.size) else it
        }
        writePoints(id, all)
        val distance = all.zipWithNext { a, b -> distanceM(a, b) }.sum()
        writeIndex(readIndex().map {
            if (it.id == id) it.copy(fixCount = all.size, distanceM = distance) else it
        })
    }

    @Synchronized
    fun end(id: String, endMs: Long) {
        writeIndex(readIndex().map { if (it.id == id) it.copy(endMs = endMs) else it })
    }

    @Synchronized
    fun list(): List<DriveSession> = readIndex().map {
        DriveSession(it.id, it.startMs, it.endMs, it.fixCount, it.distanceM)
    }

    @Synchronized
    fun points(id: String): List<RouteTrail.Point> = readPoints(id)

    @Synchronized
    fun delete(id: String) {
        fileFor(id).delete()
        writeIndex(readIndex().filter { it.id != id })
    }

    private fun fileFor(id: String) = File(dir, "$id.json")

    private fun readIndex(): List<Entry> = runCatching {
        if (!indexFile.exists()) return@runCatching emptyList()
        val arr = JSONArray(indexFile.readText())
        (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            Entry(
                id = o.getString("id"),
                startMs = o.getLong("startMs"),
                endMs = if (o.isNull("endMs")) null else o.getLong("endMs"),
                fixCount = o.getInt("fixCount"),
                distanceM = o.getDouble("distanceM"),
            )
        }
    }.getOrDefault(emptyList())

    private fun writeIndex(entries: List<Entry>) {
        dir.mkdirs()
        val arr = JSONArray()
        for (e in entries) {
            arr.put(
                JSONObject()
                    .put("id", e.id)
                    .put("startMs", e.startMs)
                    .put("endMs", e.endMs ?: JSONObject.NULL)
                    .put("fixCount", e.fixCount)
                    .put("distanceM", e.distanceM),
            )
        }
        indexFile.writeText(arr.toString())
    }

    private fun readPoints(id: String): List<RouteTrail.Point> = runCatching {
        val file = fileFor(id)
        if (!file.exists()) return@runCatching emptyList()
        val arr = JSONObject(file.readText()).getJSONArray("points")
        (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            RouteTrail.Point(
                lat = o.getDouble("lat"),
                lng = o.getDouble("lng"),
                accuracyM = o.getDouble("acc").toFloat(),
                timeMs = o.getLong("t"),
            )
        }
    }.getOrDefault(emptyList())

    private fun writePoints(id: String, points: List<RouteTrail.Point>) {
        dir.mkdirs()
        val arr = JSONArray()
        for (p in points) {
            arr.put(
                JSONObject()
                    .put("lat", p.lat)
                    .put("lng", p.lng)
                    .put("acc", p.accuracyM.toDouble())
                    .put("t", p.timeMs),
            )
        }
        fileFor(id).writeText(JSONObject().put("points", arr).toString())
    }

    private fun distanceM(a: RouteTrail.Point, b: RouteTrail.Point): Double {
        val r = 6_371_000.0
        val p1 = Math.toRadians(a.lat)
        val p2 = Math.toRadians(b.lat)
        val dPhi = Math.toRadians(b.lat - a.lat)
        val dLambda = Math.toRadians(b.lng - a.lng)
        val h = sin(dPhi / 2).pow(2) + cos(p1) * cos(p2) * sin(dLambda / 2).pow(2)
        return 2 * r * asin(sqrt(h))
    }

    companion object {
        const val MAX_SESSIONS = 20
        const val MAX_POINTS = 5_000
    }
}

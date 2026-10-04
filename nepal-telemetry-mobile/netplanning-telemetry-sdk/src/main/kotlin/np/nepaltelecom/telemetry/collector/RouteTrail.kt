package np.nepaltelecom.telemetry.collector

/**
 * In-memory trail of the fixes accepted by the current drive test. Used only
 * to draw the route on the phone. It is never written to disk or uploaded
 * through this path; the upload queue gets its own copy of each fix as a
 * Sample. Capped so a long drive can't grow without limit.
 */
object RouteTrail {

    data class Point(
        val lat: Double,
        val lng: Double,
        val accuracyM: Float,
        val timeMs: Long,
    )

    private const val MAX_POINTS = 5_000
    private val points = ArrayList<Point>()

    @Synchronized
    fun add(point: Point) {
        if (points.size >= MAX_POINTS) points.removeAt(0)
        points.add(point)
    }

    @Synchronized
    fun points(): List<Point> = points.toList()

    @Synchronized
    fun clear() {
        points.clear()
    }
}

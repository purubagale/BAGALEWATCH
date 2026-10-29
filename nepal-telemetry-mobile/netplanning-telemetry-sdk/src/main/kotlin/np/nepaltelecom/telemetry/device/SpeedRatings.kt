package np.nepaltelecom.telemetry.device

/**
 * How good a speed test result is for four everyday uses (2026-10-29, like
 * Ookla's dots): browsing, video streaming, gaming and video calls. Fixed
 * limits on download, upload, ping, jitter, packet loss and loaded latency.
 * The server holds the same table (core/speed_quality.py); keep the two in
 * step. A limit whose figure is missing is skipped; with no download, no
 * rating.
 */
object SpeedRatings {

    enum class Level(val label: String, val score: Int) { POOR("Poor", 1), FAIR("Fair", 2), GOOD("Good", 3), VERY_GOOD("Very good", 4) }

    enum class Use(val label: String) { BROWSING("Browsing"), VIDEO("Video streaming"), GAMING("Gaming"), VIDEO_CALL("Video calls") }

    /** Limits for one level: minimum download and upload (Mbps), maximum ping, jitter, loss %, loaded latency (ms). */
    private class Limits(
        val down: Double? = null, val up: Double? = null, val ping: Double? = null, val jitter: Double? = null,
        val loss: Double? = null, val loaded: Double? = null,
    )

    private val TABLE: Map<Use, List<Pair<Level, Limits>>> = linkedMapOf(
        Use.BROWSING to listOf(
            Level.VERY_GOOD to Limits(down = 25.0, ping = 50.0, loaded = 300.0),
            Level.GOOD to Limits(down = 10.0, ping = 100.0, loaded = 600.0),
            Level.FAIR to Limits(down = 3.0, ping = 200.0),
        ),
        Use.VIDEO to listOf(
            Level.VERY_GOOD to Limits(down = 25.0),
            Level.GOOD to Limits(down = 10.0),
            Level.FAIR to Limits(down = 3.0),
        ),
        Use.GAMING to listOf(
            Level.VERY_GOOD to Limits(down = 5.0, ping = 30.0, jitter = 10.0, loss = 0.5, loaded = 100.0),
            Level.GOOD to Limits(down = 3.0, ping = 60.0, jitter = 20.0, loss = 1.0, loaded = 200.0),
            Level.FAIR to Limits(down = 1.0, ping = 100.0, jitter = 30.0, loss = 2.5, loaded = 400.0),
        ),
        Use.VIDEO_CALL to listOf(
            Level.VERY_GOOD to Limits(down = 10.0, up = 10.0, ping = 50.0, jitter = 15.0, loss = 0.5, loaded = 150.0),
            Level.GOOD to Limits(down = 3.0, up = 3.0, ping = 100.0, jitter = 30.0, loss = 1.0, loaded = 250.0),
            Level.FAIR to Limits(down = 1.0, up = 1.0, ping = 150.0, jitter = 50.0, loss = 3.0, loaded = 500.0),
        ),
    )

    fun rate(r: SpeedTest.Result): Map<Use, Level> {
        val down = r.downloadMbps ?: return emptyMap()
        val loaded = listOfNotNull(r.latencyDownMs, r.latencyUpMs).maxOrNull()
        return TABLE.mapValues { (_, levels) ->
            levels.firstOrNull { (_, l) ->
                (l.down == null || down >= l.down) &&
                    (l.up == null || r.uploadMbps == null || r.uploadMbps >= l.up) &&
                    (l.ping == null || r.pingMedianMs == null || r.pingMedianMs <= l.ping) &&
                    (l.jitter == null || r.jitterMs == null || r.jitterMs <= l.jitter) &&
                    (l.loss == null || r.packetLossPct == null || r.packetLossPct <= l.loss) &&
                    (l.loaded == null || loaded == null || loaded <= l.loaded)
            }?.first ?: Level.POOR
        }
    }

    /** "Browsing: Good · Video streaming: Very good · ..." for a result screen. */
    fun describe(r: SpeedTest.Result): String =
        rate(r).entries.joinToString(" · ") { (use, level) -> "${use.label}: ${level.label}" }
}

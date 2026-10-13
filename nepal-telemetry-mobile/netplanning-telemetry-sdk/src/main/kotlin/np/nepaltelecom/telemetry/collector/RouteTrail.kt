package np.nepaltelecom.telemetry.collector

import np.nepaltelecom.telemetry.model.Sample

/**
 * In-memory trail of the fixes accepted by the current drive test. Used only
 * to draw the route on the phone. It is never uploaded through this path; the
 * upload queue gets its own copy of each fix as a Sample. Capped so a long
 * drive can't grow without limit.
 */
object RouteTrail {

    /**
     * The serving-cell reading taken at a fix (2026-10-12), kept so the phone's
     * own map can show what the signal was at any point of the route. Which
     * fields are set depends on the technology: a 2G reading has no RSRP, a 4G
     * one no Rx quality.
     */
    data class Signal(
        val networkType: String,
        val rsrpDbm: Int? = null,
        val rsrqDb: Int? = null,
        val sinrDb: Int? = null,
        val rssiDbm: Int? = null,
        val rscpDbm: Int? = null,
        val ecioDb: Int? = null,
        val rxQual: Int? = null,
        val cqi: Int? = null,
        val pci: Int? = null,
        val scramblingCode: Int? = null,
        val bcch: Int? = null,
        val bsic: Int? = null,
        val cellId: Long? = null,
        val arfcn: Int? = null,
        val band: Int? = null,
    ) {
        companion object {
            fun from(s: Sample) = Signal(
                networkType = s.networkType, rsrpDbm = s.rsrpDbm, rsrqDb = s.rsrqDb, sinrDb = s.sinrDb,
                rssiDbm = s.rssiDbm, rscpDbm = s.rscpDbm, ecioDb = s.ecioDb, rxQual = s.rxQual, cqi = s.cqi,
                pci = s.pci, scramblingCode = s.scramblingCode, bcch = s.bcch, bsic = s.bsic, cellId = s.cellId,
                arfcn = s.arfcn, band = s.band,
            )
        }
    }

    data class Point(
        val lat: Double,
        val lng: Double,
        val accuracyM: Float,
        val timeMs: Long,
        // Filled in a moment after the fix, once the cell has been read. Null
        // for drives saved before 2026-10-12 and when no cell was readable.
        @Volatile var signal: Signal? = null,
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

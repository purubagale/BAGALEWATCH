package np.nepaltelecom.telemetry.model

import org.json.JSONArray
import org.json.JSONObject

/**
 * The other cells the phone hears at the moment of a reading (2026-10-27),
 * sent with the reading so the server can see which sites reach a place
 * besides the serving one (missing neighbours, overshooting, pilot
 * pollution, a stronger cell the phone did not move to).
 *
 * Kept small on purpose, since every reading carries it:
 *  - only cells with an identity (PCI, scrambling code or BCCH) and a level;
 *  - the serving cell is never repeated here;
 *  - cells of the serving technology first, strongest first, at most
 *    [MAX_SAME_TECH]; then at most [MAX_OTHER_TECH] per other technology;
 *    at most [MAX_TOTAL] in all;
 *  - only the fields that identify the cell and its level, no timestamps.
 */
object NeighbourCells {
    const val MAX_TOTAL = 8
    const val MAX_SAME_TECH = 6
    const val MAX_OTHER_TECH = 3

    private val TECH_ORDER = listOf("LTE", "UMTS", "GSM")

    /** The neighbours worth sending, in order; empty when none qualify. */
    fun select(cells: List<CellReading>, servingNetwork: String?): List<CellReading> {
        val usable = cells.filter { !it.isServing && identity(it) != null && level(it) != null }
        if (usable.isEmpty()) return emptyList()
        val order = listOfNotNull(servingNetwork?.takeIf { it in TECH_ORDER }) + TECH_ORDER.filter { it != servingNetwork }
        val out = mutableListOf<CellReading>()
        for (net in order) {
            val cap = if (net == servingNetwork) MAX_SAME_TECH else MAX_OTHER_TECH
            out += usable.filter { it.networkType == net }.sortedByDescending { level(it) }.take(cap)
        }
        return out.take(MAX_TOTAL)
    }

    /** PCI on 4G, scrambling code on 3G, BCCH on 2G. */
    private fun identity(c: CellReading): Int? = when (c.networkType) {
        "LTE" -> c.pci
        "UMTS" -> c.scramblingCode
        "GSM" -> c.bcch
        else -> null
    }

    /** RSRP on 4G, RSCP on 3G, RSSI on 2G: the level the server rates. */
    private fun level(c: CellReading): Int? = when (c.networkType) {
        "LTE" -> c.rsrpDbm
        "UMTS" -> c.rscpDbm ?: c.rssiDbm
        "GSM" -> c.rssiDbm
        else -> null
    }

    fun toJson(cells: List<CellReading>): JSONArray = JSONArray().apply {
        for (c in cells) put(JSONObject().apply {
            put("net", c.networkType)
            putOpt("pci", c.pci)
            putOpt("psc", c.scramblingCode)
            putOpt("bcch", c.bcch)
            putOpt("bsic", c.bsic)
            putOpt("arfcn", if (c.networkType == "GSM") c.bcch else c.earfcn)
            putOpt("band", c.band)
            putOpt("cell_id", c.cellId)
            putOpt("tac", c.tac)
            putOpt("rsrp", c.rsrpDbm)
            putOpt("rsrq", c.rsrqDb)
            putOpt("sinr", c.sinrDb)
            putOpt("rscp", c.rscpDbm)
            putOpt("ecio", c.ecioDb)
            putOpt("rssi", if (c.networkType == "GSM") c.rssiDbm else null)
        })
    }

    /** Reads back what [toJson] wrote (the local queue keeps readings as JSON). */
    fun fromJson(a: JSONArray): List<CellReading> = List(a.length()) { i ->
        val o = a.getJSONObject(i)
        val net = o.optString("net", "LTE")
        CellReading(
            networkType = net, isServing = false, mcc = null, mnc = null,
            cellId = o.longOrNull("cell_id"), pci = o.intOrNull("pci"), tac = o.intOrNull("tac"),
            earfcn = if (net == "GSM") null else o.intOrNull("arfcn"),
            scramblingCode = o.intOrNull("psc"), bcch = o.intOrNull("bcch"), bsic = o.intOrNull("bsic"),
            rsrpDbm = o.intOrNull("rsrp"), rsrqDb = o.intOrNull("rsrq"), sinrDb = o.intOrNull("sinr"),
            rssiDbm = o.intOrNull("rssi"), rscpDbm = o.intOrNull("rscp"), ecioDb = o.intOrNull("ecio"),
            band = o.intOrNull("band"),
        )
    }

    private fun JSONObject.intOrNull(key: String): Int? = if (has(key) && !isNull(key)) getInt(key) else null
    private fun JSONObject.longOrNull(key: String): Long? = if (has(key) && !isNull(key)) getLong(key) else null
}

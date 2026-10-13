package np.nepaltelecom.telemetry.model

/**
 * Operating band of a cell, from its channel number (2026-10-13).
 *
 * A phone reports the channel its serving cell is on: EARFCN on 4G, UARFCN
 * on 3G, the BCCH ARFCN on 2G. Android 11 and later also reports the band
 * itself; where it does, that value is used and this table is not.
 *
 * The tables hold the bands a phone can meet in Nepal and the region, not
 * every band in the specifications. A channel outside them gives no band,
 * never a guess. The server holds the same tables
 * (backend-django/core/radio_band.py) and fills in a band the phone left
 * out, so keep the two in step.
 *
 * Downlink ranges: 3GPP TS 36.101 table 5.7.3-1 (4G), TS 25.101 table 5.1
 * (3G), TS 45.005 table 2-2 (2G).
 */
object RadioBand {

    private class Range(val first: Int, val last: Int, val band: Int?, val mhz: Int)

    private val lte = listOf(
        Range(0, 599, 1, 2100), Range(600, 1199, 2, 1900), Range(1200, 1949, 3, 1800),
        Range(1950, 2399, 4, 1700), Range(2400, 2649, 5, 850), Range(2750, 3449, 7, 2600),
        Range(3450, 3799, 8, 900), Range(6150, 6449, 20, 800), Range(9210, 9659, 28, 700),
        Range(37750, 38249, 38, 2600), Range(38250, 38649, 39, 1900),
        Range(38650, 39649, 40, 2300), Range(39650, 41589, 41, 2500),
    )

    private val umts = listOf(
        Range(10562, 10838, 1, 2100), Range(9662, 9938, 2, 1900), Range(1162, 1513, 3, 1800),
        Range(4357, 4458, 5, 850), Range(2937, 3088, 8, 900),
    )

    // 2G bands are named by frequency and carry no band number here.
    private val gsm = listOf(
        Range(0, 124, null, 900), Range(975, 1023, null, 900),
        Range(128, 251, null, 850), Range(512, 885, null, 1800),
    )

    private val mhzOfBand = mapOf(
        1 to 2100, 2 to 1900, 3 to 1800, 4 to 1700, 5 to 850, 7 to 2600, 8 to 900, 20 to 800,
        28 to 700, 38 to 2600, 39 to 1900, 40 to 2300, 41 to 2500, 77 to 3700, 78 to 3500,
    )

    private fun find(table: List<Range>, channel: Int?): Range? =
        channel?.let { c -> table.firstOrNull { c in it.first..it.last } }

    /** 3GPP band number for a channel, or null on 2G and for a channel not in the table. */
    fun bandOf(networkType: String, channel: Int?): Int? = when (networkType) {
        "LTE" -> find(lte, channel)?.band
        "UMTS" -> find(umts, channel)?.band
        else -> null
    }

    /**
     * Text for the screen: "B3 · 1800", "n78 · 3500", "900 MHz" on 2G, or null
     * when nothing is known. [band] is what the phone or [bandOf] gave;
     * [channel] is used on 2G, and as a fallback elsewhere.
     */
    fun label(networkType: String, band: Int?, channel: Int?): String? {
        if (networkType == "GSM") return find(gsm, channel)?.let { "${it.mhz} MHz" }
        val b = band ?: bandOf(networkType, channel) ?: return null
        val name = if (networkType == "NR") "n$b" else "B$b"
        return mhzOfBand[b]?.let { "$name · $it" } ?: name
    }
}

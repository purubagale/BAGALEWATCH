package np.nepaltelecom.telemetry.model

/**
 * The site and sector of a Nepal Telecom cell, read from its number alone
 * (2026-10-19), so the phone can name them without the server. NTC's
 * numbering, checked on the whole site list:
 *
 *  - 4G: eNodeB = region digit + site number (1856 is KTM856); the local
 *    cell ID is the sector: 1 J3, 2 K3, 3 L3, 4 J20, 5 K20, 6 L20, 7 M3,
 *    8 N3 (right for 99% of sectors).
 *  - 2G: CI = 1 + site number + sector digit (11431 is site 143 sector A);
 *    3G: CI = 2 + site number + sector digit (1 P1, 2 Q1, 3 R1, 4 P2,
 *    5 Q2, 6 R2). The region comes from the first two digits of the LAC.
 *
 * The site's own name (e.g. "BOHORATAR1") is only in the site list, so the
 * server still supplies it when it can be reached. The server applies the
 * same eNodeB rule (core/dt_serving_cell.py site_of_enodeb).
 */
object NtcCellName {
    data class Name(val siteId: String, val sector: String)

    private val ENB_REGION = mapOf(1 to "KTM", 2 to "EDR", 3 to "CDR", 4 to "WDR", 5 to "MWDR", 6 to "FWDR")
    private val LTE_SECTOR = mapOf(1 to "J3", 2 to "K3", 3 to "L3", 4 to "J20", 5 to "K20", 6 to "L20", 7 to "M3", 8 to "N3")
    private val UMTS_SECTOR = mapOf(1 to "P1", 2 to "Q1", 3 to "R1", 4 to "P2", 5 to "Q2", 6 to "R2", 7 to "S1", 8 to "T1", 9 to "U1")

    private fun regionOfLac(lac: Int?): String? = when (lac?.toString()?.take(2)?.toIntOrNull()) {
        10 -> "KTM"
        11, 12, 13 -> "EDR"
        14, 15, 16 -> "CDR"
        17, 18, 19 -> "WDR"
        20, 21, 22 -> "MWDR"
        23, 24 -> "FWDR"
        else -> null
    }

    /** The site and sector, or null when the cell is not NTC's or does not follow the numbering. */
    fun of(s: Sample): Name? {
        if (s.mcc != null && s.mnc != null && Operators.name(s.mcc, s.mnc) != "Nepal Telecom") return null
        val cellId = s.cellId ?: return null
        return when (s.networkType) {
            "LTE" -> {
                val enb = (cellId shr 8).toInt()
                val region = ENB_REGION[enb / 1000]
                val sector = LTE_SECTOR[(cellId and 0xFF).toInt()]
                if (enb in 1000..6999 && region != null && sector != null) Name("$region${"%03d".format(enb % 1000)}", sector) else null
            }
            "GSM" -> fromCi(cellId.toInt(), '1', s.tac) { d -> ('A' + (d - 1)).toString() }
            "UMTS" -> fromCi((cellId and 0xFFFF).toInt(), '2', s.tac) { d -> UMTS_SECTOR[d] }
            else -> null
        }
    }

    private fun fromCi(ci: Int, lead: Char, lac: Int?, sector: (Int) -> String?): Name? {
        val text = ci.toString()
        if (text.length != 5 || text[0] != lead) return null
        val region = regionOfLac(lac) ?: return null
        val digit = text[4].digitToInt()
        if (digit == 0) return null
        val name = sector(digit) ?: return null
        return Name("$region${text.substring(1, 4)}", name)
    }
}

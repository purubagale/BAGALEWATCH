package np.nepaltelecom.telemetry.model

/**
 * Operator names for the network codes a phone reports (2026-10-19), so
 * screens say "Nepal Telecom" rather than "429 / 01". The server keeps the
 * same table (core/operators.py); keep the two in step.
 */
object Operators {
    private val NAMES = mapOf(
        "429/01" to "Nepal Telecom",
        "429/02" to "Ncell",
        "429/03" to "UTL",
        "429/04" to "Smart Telecom",
    )

    /** The operator's name, else "MCC / MNC", else null when neither code is known. */
    fun name(mcc: String?, mnc: String?): String? {
        if (mcc == null && mnc == null) return null
        return NAMES["$mcc/$mnc"] ?: "${mcc ?: "?"} / ${mnc ?: "?"}"
    }
}

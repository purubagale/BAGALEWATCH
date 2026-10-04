package np.nepaltelecom.telemetry.model

/**
 * One cell the phone can currently see: the serving cell or a neighbour.
 * Local display only. Nothing here is uploaded through this type, so the
 * neighbour list is never sent to the server.
 *
 * Fields are nullable for the same reason as [Sample]: not every radio and
 * not every device reports every value.
 */
data class CellReading(
    val networkType: String,        // "LTE", "UMTS", or "GSM"
    val isServing: Boolean,         // true for the cell the phone is camped on
    val mcc: String?,
    val mnc: String?,
    val cellId: Long?,              // LTE: ECI (eNB * 256 + sector). UMTS/GSM: cell id
    val pci: Int?,                  // LTE physical cell id
    val tac: Int?,                  // LTE TAC, or LAC on 2G/3G
    val earfcn: Int?,               // LTE EARFCN, or UARFCN on 3G
    val scramblingCode: Int?,       // UMTS
    val bcch: Int?,                 // GSM BCCH ARFCN
    val bsic: Int?,                 // GSM BSIC
    val rsrpDbm: Int?,
    val rsrqDb: Int?,
    val sinrDb: Int?,
    val rssiDbm: Int?,
    val rscpDbm: Int?,
    val ecioDb: Int?,
)

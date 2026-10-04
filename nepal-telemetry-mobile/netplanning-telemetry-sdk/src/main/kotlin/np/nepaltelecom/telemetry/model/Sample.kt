package np.nepaltelecom.telemetry.model

import org.json.JSONObject

/**
 * One network-quality reading. Deliberately flat and JSON-friendly -- this is
 * exactly what goes in the local queue file and, batched, in the upload body.
 *
 * Field choices trace directly back to the scoping brief:
 *  - [deviceId] is a locally generated pseudonymous UUID (see
 *    [np.nepaltelecom.telemetry.storage.DeviceIdentity]), never the IMEI,
 *    Android ID, or subscriber/MSISDN identifier -- that's a deliberate
 *    privacy choice, not an oversight, per "no linkage to subscriber
 *    identity" in the pilot's data-handling section.
 *  - Signal fields are nullable because not every radio generation reports
 *    every metric (a 2G reading won't have an SINR, for instance).
 */
data class Sample(
    val deviceId: String,
    val timestampMs: Long,
    val lat: Double?,
    val lon: Double?,
    val gpsAccuracyM: Float?,
    val cellId: Long?,
    val pci: Int?,
    val tac: Int?,
    val mcc: String?,
    val mnc: String?,
    val networkType: String,        // e.g. "LTE", "NR", "UMTS", "GSM", "UNKNOWN"
    val rsrpDbm: Int?,
    val rsrqDb: Int?,
    val rssiDbm: Int?,
    val sinrDb: Int?,
    // rxQual (2026-09-03): GSM-only "RxQual"/bit-error-rate class (TS
    // 45.008/27.007 8.5, 0-7) -- see CellSampleCollector.kt's
    // bitErrorRateOrNull(). rscpDbm/ecioDb: WCDMA-only RSCP and Ec/Io
    // (API 29+ only, see that same file). All three null for every other
    // RAT, same nullability convention as the fields above.
    val rxQual: Int?,
    val rscpDbm: Int?,
    val ecioDb: Int?,
    // Serving-cell identities for 3G and 2G (2026-10-04). PCI for LTE stays
    // in [pci]; these carry the other physical-layer ids, so the server can
    // match the serving cell to a site on every technology:
    //  - scramblingCode: UMTS primary scrambling code, from
    //    CellIdentityWcdma.getPsc(). Sent here, not in [pci].
    //  - bcch / bsic: GSM BCCH ARFCN (CellIdentityGsm.getArfcn()) and BSIC
    //    (CellIdentityGsm.getBsic()), both available from API 24.
    val scramblingCode: Int? = null,
    val bcch: Int? = null,
    val bsic: Int? = null,
    val batteryPct: Int?,
    val triggerReason: String,      // "periodic" | "handover" | "manual" | "drive" | "drive_start" | "drive_stop"
    // Set on fixes and markers taken during a drive test (2026-10-04). One UUID
    // per drive, so the server can match a drive's samples exactly.
    val driveSessionId: String? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("device_id", deviceId)
        put("ts", timestampMs)
        putOpt("lat", lat)
        putOpt("lon", lon)
        putOpt("gps_accuracy_m", gpsAccuracyM)
        putOpt("cell_id", cellId)
        putOpt("pci", pci)
        putOpt("tac", tac)
        putOpt("mcc", mcc)
        putOpt("mnc", mnc)
        put("network_type", networkType)
        putOpt("rsrp_dbm", rsrpDbm)
        putOpt("rsrq_db", rsrqDb)
        putOpt("rssi_dbm", rssiDbm)
        putOpt("sinr_db", sinrDb)
        putOpt("rx_qual", rxQual)
        putOpt("rscp_dbm", rscpDbm)
        putOpt("ecio_db", ecioDb)
        putOpt("scrambling_code", scramblingCode)
        putOpt("bcch", bcch)
        putOpt("bsic", bsic)
        putOpt("battery_pct", batteryPct)
        put("trigger_reason", triggerReason)
        putOpt("drive_session_id", driveSessionId)
    }

    companion object {
        fun fromJson(o: JSONObject): Sample = Sample(
            deviceId = o.getString("device_id"),
            timestampMs = o.getLong("ts"),
            lat = o.optDoubleOrNull("lat"),
            lon = o.optDoubleOrNull("lon"),
            gpsAccuracyM = o.optDoubleOrNull("gps_accuracy_m")?.toFloat(),
            cellId = o.optLongOrNull("cell_id"),
            pci = o.optIntOrNull("pci"),
            tac = o.optIntOrNull("tac"),
            mcc = o.optString("mcc", null),
            mnc = o.optString("mnc", null),
            networkType = o.getString("network_type"),
            rsrpDbm = o.optIntOrNull("rsrp_dbm"),
            rsrqDb = o.optIntOrNull("rsrq_db"),
            rssiDbm = o.optIntOrNull("rssi_dbm"),
            sinrDb = o.optIntOrNull("sinr_db"),
            rxQual = o.optIntOrNull("rx_qual"),
            rscpDbm = o.optIntOrNull("rscp_dbm"),
            ecioDb = o.optIntOrNull("ecio_db"),
            scramblingCode = o.optIntOrNull("scrambling_code"),
            bcch = o.optIntOrNull("bcch"),
            bsic = o.optIntOrNull("bsic"),
            batteryPct = o.optIntOrNull("battery_pct"),
            triggerReason = o.optString("trigger_reason", "periodic"),
            driveSessionId = o.optString("drive_session_id", "").takeIf { it.isNotEmpty() },
        )
    }
}

// JSONObject's own optX methods return sentinel values (0, 0.0) rather than
// null when a key is absent, which silently corrupts anything that could
// legitimately BE zero (e.g. rsrqDb = 0). These make "absent" explicit.
private fun JSONObject.optDoubleOrNull(key: String): Double? = if (has(key) && !isNull(key)) getDouble(key) else null
private fun JSONObject.optIntOrNull(key: String): Int? = if (has(key) && !isNull(key)) getInt(key) else null
private fun JSONObject.optLongOrNull(key: String): Long? = if (has(key) && !isNull(key)) getLong(key) else null

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
    // 2G/3G-proper equivalents of the LTE/NR fields above, plus LTE/NR's CQI
    // -- added 2026-10-03 per the mobile integration guide's field reference
    // (§5). Left out of the original cut because the pilot started LTE-only;
    // these fill the 2G/3G gap rather than overloading rsrpDbm/rsrqDb/sinrDb,
    // which the backend treats as LTE/NR-only.
    val rxQual: Int?,    // GSM only -- RxQual class 0-7 (3GPP TS 45.008 / TS 27.007 §8.5)
    val rscpDbm: Int?,   // WCDMA only -- API 29+ only, see CellSampleCollector
    val ecioDb: Int?,    // WCDMA only -- API 29+ only, see CellSampleCollector
    val cqi: Int?,       // LTE only -- API 29+ only; no public getter exists for NR, see CellSampleCollector
    val batteryPct: Int?,
    val triggerReason: String,      // "periodic" | "handover" | "manual"
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
        putOpt("cqi", cqi)
        putOpt("battery_pct", batteryPct)
        put("trigger_reason", triggerReason)
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
            mcc = o.optStringOrNull("mcc"),
            mnc = o.optStringOrNull("mnc"),
            networkType = o.getString("network_type"),
            rsrpDbm = o.optIntOrNull("rsrp_dbm"),
            rsrqDb = o.optIntOrNull("rsrq_db"),
            rssiDbm = o.optIntOrNull("rssi_dbm"),
            sinrDb = o.optIntOrNull("sinr_db"),
            rxQual = o.optIntOrNull("rx_qual"),
            rscpDbm = o.optIntOrNull("rscp_dbm"),
            ecioDb = o.optIntOrNull("ecio_db"),
            cqi = o.optIntOrNull("cqi"),
            batteryPct = o.optIntOrNull("battery_pct"),
            triggerReason = o.optString("trigger_reason", "periodic"),
        )
    }
}

// JSONObject's own optX methods return sentinel values (0, 0.0) rather than
// null when a key is absent, which silently corrupts anything that could
// legitimately BE zero (e.g. rsrqDb = 0). These make "absent" explicit.
private fun JSONObject.optDoubleOrNull(key: String): Double? = if (has(key) && !isNull(key)) getDouble(key) else null
private fun JSONObject.optIntOrNull(key: String): Int? = if (has(key) && !isNull(key)) getInt(key) else null
private fun JSONObject.optLongOrNull(key: String): Long? = if (has(key) && !isNull(key)) getLong(key) else null
// Also avoids JSONObject.optString(key, null), whose fallback param is declared
// non-null -- passing null there is a Kotlin nullability warning.
private fun JSONObject.optStringOrNull(key: String): String? = if (has(key) && !isNull(key)) getString(key) else null

package np.nepaltelecom.telemetry.model

import org.json.JSONObject

/**
 * One completed call's VoLTE/VoNR quality reading (mobile integration guide
 * §12, field reference §2). Sent once per completed call -- NOT batched on
 * the periodic/handover schedule [Sample] uses; see
 * [np.nepaltelecom.telemetry.collector.VolteCallQualityListener] (collection)
 * and [np.nepaltelecom.telemetry.upload.VolteApi] (upload).
 *
 * No on-device MOS computation, by design (§12.2/§12.4 of the handoff doc):
 * the backend computes r_factor/mos_estimate itself from these raw metrics,
 * so a future constant correction (see that doc's §12.3) applies
 * retroactively server-side, with no SDK change or app re-release needed.
 */
data class VolteSample(
    val deviceId: String,
    val timestampMs: Long,
    val callDurationS: Int?,
    val codec: String?,          // "AMR-WB" | "AMR-NB" | "EVS" | "G.711" | "G.729" | null if unrecognized
    val packetLossPct: Float?,   // 0-100
    val jitterMs: Float?,
    val rttMs: Float?,
    val qualityLevel: String?,   // "EXCELLENT" | "GOOD" | "FAIR" | "POOR" | "BAD" | "NOT_AVAILABLE"
    val networkType: String,     // "LTE" | "NR" | "UNKNOWN" -- the call's own network, not necessarily the generic serving-cell reading
    val lat: Double?,
    val lon: Double?,
    val cellId: Long?,
    val pci: Int?,
    val tac: Int?,
    val mcc: String?,
    val mnc: String?,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("device_id", deviceId)
        put("ts", timestampMs)
        putOpt("call_duration_s", callDurationS)
        putOpt("codec", codec)
        putOpt("packet_loss_pct", packetLossPct?.toDouble())
        putOpt("jitter_ms", jitterMs?.toDouble())
        putOpt("rtt_ms", rttMs?.toDouble())
        putOpt("quality_level", qualityLevel)
        put("network_type", networkType)
        putOpt("lat", lat)
        putOpt("lon", lon)
        putOpt("cell_id", cellId)
        putOpt("pci", pci)
        putOpt("tac", tac)
        putOpt("mcc", mcc)
        putOpt("mnc", mnc)
    }

    companion object {
        fun fromJson(o: JSONObject): VolteSample = VolteSample(
            deviceId = o.getString("device_id"),
            timestampMs = o.getLong("ts"),
            callDurationS = o.optIntOrNull("call_duration_s"),
            codec = o.optStringOrNull("codec"),
            packetLossPct = o.optDoubleOrNull("packet_loss_pct")?.toFloat(),
            jitterMs = o.optDoubleOrNull("jitter_ms")?.toFloat(),
            rttMs = o.optDoubleOrNull("rtt_ms")?.toFloat(),
            qualityLevel = o.optStringOrNull("quality_level"),
            networkType = o.getString("network_type"),
            lat = o.optDoubleOrNull("lat"),
            lon = o.optDoubleOrNull("lon"),
            cellId = o.optLongOrNull("cell_id"),
            pci = o.optIntOrNull("pci"),
            tac = o.optIntOrNull("tac"),
            mcc = o.optStringOrNull("mcc"),
            mnc = o.optStringOrNull("mnc"),
        )
    }
}

// Same "absent must mean null, not a sentinel" reasoning as Sample.kt's
// identical-looking private helpers -- Kotlin top-level `private` is
// file-scoped, so these don't collide with that file's copies despite being
// in the same package.
private fun JSONObject.optDoubleOrNull(key: String): Double? = if (has(key) && !isNull(key)) getDouble(key) else null
private fun JSONObject.optIntOrNull(key: String): Int? = if (has(key) && !isNull(key)) getInt(key) else null
private fun JSONObject.optLongOrNull(key: String): Long? = if (has(key) && !isNull(key)) getLong(key) else null
private fun JSONObject.optStringOrNull(key: String): String? = if (has(key) && !isNull(key)) getString(key) else null

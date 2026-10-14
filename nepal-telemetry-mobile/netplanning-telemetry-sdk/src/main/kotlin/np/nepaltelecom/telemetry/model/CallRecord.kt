package np.nepaltelecom.telemetry.model

import org.json.JSONArray
import org.json.JSONObject

/**
 * One phone call as an ordinary app can see it (2026-10-14). No quality
 * figures (those need a carrier-privileged app), no number, no direction:
 * the voice network the call used, read every few seconds, the data network
 * just before it, its start and end, and the serving cell and level at each
 * end. Sent to the server's `call-samples/` endpoint.
 */
data class CallRecord(
    val deviceId: String,
    val startedAtMs: Long,
    val endedAtMs: Long,
    val voiceNetworks: List<String>,   // in order, repeats removed, e.g. ["LTE", "UMTS"]
    val dataNetworkBefore: String?,
    val start: CallPoint?,
    val end: CallPoint?,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("device_id", deviceId)
        put("started_at", startedAtMs)
        put("ended_at", endedAtMs)
        put("voice_networks", JSONArray(voiceNetworks))
        voiceNetworks.firstOrNull()?.let { put("voice_network_start", it) }
        voiceNetworks.lastOrNull()?.let { put("voice_network_end", it) }
        putOpt("data_network_before", dataNetworkBefore)
        start?.let { put("start", it.toJson()) }
        end?.let { put("end", it.toJson()) }
    }

    companion object {
        fun fromJson(o: JSONObject): CallRecord {
            val nets = o.optJSONArray("voice_networks")
            return CallRecord(
                deviceId = o.getString("device_id"),
                startedAtMs = o.getLong("started_at"),
                endedAtMs = o.getLong("ended_at"),
                voiceNetworks = (0 until (nets?.length() ?: 0)).map { nets!!.getString(it) },
                dataNetworkBefore = o.optString("data_network_before", "").takeIf { it.isNotEmpty() },
                start = o.optJSONObject("start")?.let { CallPoint.fromJson(it) },
                end = o.optJSONObject("end")?.let { CallPoint.fromJson(it) },
            )
        }
    }
}

/** Serving cell and level at one moment of a call. Level: RSRP on 4G/5G, RSCP on 3G, RSSI on 2G. */
data class CallPoint(
    val lat: Double?,
    val lon: Double?,
    val networkType: String,
    val cellId: Long?,
    val pci: Int?,
    val tac: Int?,
    val mcc: String?,
    val mnc: String?,
    val levelDbm: Int?,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        putOpt("lat", lat)
        putOpt("lon", lon)
        put("network_type", networkType)
        putOpt("cell_id", cellId)
        putOpt("pci", pci)
        putOpt("tac", tac)
        putOpt("mcc", mcc)
        putOpt("mnc", mnc)
        putOpt("level_dbm", levelDbm)
    }

    companion object {
        fun from(sample: Sample): CallPoint = CallPoint(
            lat = sample.lat,
            lon = sample.lon,
            networkType = sample.networkType,
            cellId = sample.cellId,
            pci = sample.pci,
            tac = sample.tac,
            mcc = sample.mcc,
            mnc = sample.mnc,
            levelDbm = when (sample.networkType) {
                "LTE", "NR" -> sample.rsrpDbm
                "UMTS" -> sample.rscpDbm ?: sample.rssiDbm
                else -> sample.rssiDbm
            },
        )

        fun fromJson(o: JSONObject): CallPoint = CallPoint(
            lat = if (o.has("lat") && !o.isNull("lat")) o.getDouble("lat") else null,
            lon = if (o.has("lon") && !o.isNull("lon")) o.getDouble("lon") else null,
            networkType = o.optString("network_type", "UNKNOWN"),
            cellId = if (o.has("cell_id") && !o.isNull("cell_id")) o.getLong("cell_id") else null,
            pci = if (o.has("pci") && !o.isNull("pci")) o.getInt("pci") else null,
            tac = if (o.has("tac") && !o.isNull("tac")) o.getInt("tac") else null,
            mcc = o.optString("mcc", "").takeIf { it.isNotEmpty() },
            mnc = o.optString("mnc", "").takeIf { it.isNotEmpty() },
            levelDbm = if (o.has("level_dbm") && !o.isNull("level_dbm")) o.getInt("level_dbm") else null,
        )
    }
}

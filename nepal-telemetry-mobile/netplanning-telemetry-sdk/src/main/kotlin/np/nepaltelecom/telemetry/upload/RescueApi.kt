package np.nepaltelecom.telemetry.upload

import android.util.Log
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Talks to the backend's rescue-consent endpoint (`POST .../rescue-enroll/`)
 * -- a separate, explicit-consent lane from the anonymous telemetry upload
 * in [TelemetryApi]. Same deliberately-plain HttpURLConnection approach as
 * [TelemetryApi], for the same reason (no forced Retrofit/OkHttp
 * dependency), and the same `Authorization: Bearer <key>` scheme the
 * backend's `_key_from_request` already accepts from [TelemetryApi].
 */
internal class RescueApi(
    private val endpointUrl: String,
    private val apiKey: String?,
) {
    /**
     * @return the HTTP status, or -1 when the request could not be made
     * (2026-10-23: a status rather than true/false, so the worker can stop
     * on a final answer such as 410 "update the app" instead of retrying
     * it forever). Throws nothing.
     */
    fun enroll(deviceId: String, consent: Boolean, msisdn: String?, device: Map<String, String> = emptyMap()): Int {
        return try {
            val body = JSONObject().apply {
                put("device_id", deviceId)
                put("consent", consent)
                putOpt("msisdn", msisdn)
                // Make, model, app version and hardware id (2026-10-09): sent only
                // when enrolling, so the server can show which phone this number
                // is on. Blank values are left out.
                device.forEach { (key, value) -> if (value.isNotBlank()) put(key, value) }
            }.toString()
            val connection = (URL(endpointUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                apiKey?.let { setRequestProperty("Authorization", "Bearer $it") }
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 15_000
            }
            OutputStreamWriter(connection.outputStream, StandardCharsets.UTF_8).use { it.write(body) }
            val code = connection.responseCode
            val ok = code in 200..299
            if (ok) {
                Log.d(TAG, "Rescue enrollment synced (consent=$consent) -- HTTP $code")
            } else {
                // Same reasoning as TelemetryApi: surface whatever the server
                // said, since a 401/403 (bad key) vs. a 400 (bad msisdn) vs.
                // a 4xx from a schema mismatch are all silent otherwise.
                val errorBody = try {
                    connection.errorStream?.bufferedReader()?.use { it.readText() }
                } catch (e: Exception) {
                    null
                }
                Log.w(TAG, "Rescue enrollment rejected by $endpointUrl -- HTTP $code${errorBody?.let { ": $it" } ?: ""}")
            }
            connection.disconnect()
            code
        } catch (e: Exception) {
            Log.w(TAG, "Rescue enrollment request to $endpointUrl failed: ${e.javaClass.simpleName}: ${e.message}")
            -1
        }
    }

    private companion object {
        const val TAG = "NetTelemetry.Rescue"
    }
}

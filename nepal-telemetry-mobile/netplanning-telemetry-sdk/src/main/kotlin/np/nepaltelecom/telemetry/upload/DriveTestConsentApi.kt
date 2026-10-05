package np.nepaltelecom.telemetry.upload

import android.util.Log
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Talks to the backend's drive-test consent endpoint
 * (`POST .../drive-test-consent/`) -- a standing per-device flag consulted
 * only by a session an admin flagged `require_consent=True`, separate
 * from [RescueApi]'s consent (different purpose, different backend model:
 * `TelemetryDriveTestConsent` vs `SubscriberLastLocation`). Same
 * deliberately-plain HttpURLConnection approach as [TelemetryApi]/
 * [RescueApi], and the same `Authorization: Bearer <key>` scheme.
 */
internal class DriveTestConsentApi(
    private val endpointUrl: String,
    private val apiKey: String?,
) {
    /** @return true if the server accepted the request (2xx). Throws nothing -- network/parse failures return false. */
    fun setConsent(deviceId: String, consent: Boolean): Boolean {
        return try {
            val body = JSONObject().apply {
                put("device_id", deviceId)
                put("consent", consent)
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
                Log.d(TAG, "Drive-test consent synced (consent=$consent) -- HTTP $code")
            } else {
                val errorBody = try {
                    connection.errorStream?.bufferedReader()?.use { it.readText() }
                } catch (e: Exception) {
                    null
                }
                Log.w(TAG, "Drive-test consent rejected by $endpointUrl -- HTTP $code${errorBody?.let { ": $it" } ?: ""}")
            }
            connection.disconnect()
            ok
        } catch (e: Exception) {
            Log.w(TAG, "Drive-test consent request to $endpointUrl failed: ${e.javaClass.simpleName}: ${e.message}")
            false
        }
    }

    /**
     * GET the current consent message from `endpointUrl` (expected to be
     * [np.nepaltelecom.telemetry.TelemetryConfig.driveTestConsentMessageUrl]
     * here, NOT the POST-only consent-set endpoint -- this class is reused
     * for both since they're the same "talk to a consent-related endpoint
     * with this key" shape, not because they're the same URL).
     *
     * @return the message, or null on any failure (offline, non-2xx,
     * unparseable body) -- this is a best-effort read with an obvious safe
     * fallback (the caller shows its own hardcoded copy instead), so it
     * never throws.
     */
    fun fetchMessage(): String? {
        return try {
            val connection = (URL(endpointUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                apiKey?.let { setRequestProperty("Authorization", "Bearer $it") }
                connectTimeout = 15_000
                readTimeout = 15_000
            }
            val code = connection.responseCode
            val message = if (code in 200..299) {
                val body = connection.inputStream.bufferedReader().use { it.readText() }
                JSONObject(body).optString("message", "").ifBlank { null }
            } else {
                Log.w(TAG, "Drive-test consent message fetch from $endpointUrl rejected -- HTTP $code")
                null
            }
            connection.disconnect()
            message
        } catch (e: Exception) {
            Log.w(TAG, "Drive-test consent message fetch from $endpointUrl failed: ${e.javaClass.simpleName}: ${e.message}")
            null
        }
    }

    private companion object {
        const val TAG = "NetTelemetry.DtConsent"
    }
}

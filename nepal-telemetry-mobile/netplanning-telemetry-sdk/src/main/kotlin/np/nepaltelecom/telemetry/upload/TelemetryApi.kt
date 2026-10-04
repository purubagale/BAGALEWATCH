package np.nepaltelecom.telemetry.upload

import android.util.Log
import np.nepaltelecom.telemetry.model.Sample
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Deliberately plain HttpURLConnection rather than adding Retrofit/OkHttp as
 * a hard dependency -- most host apps (Nepal Telecom's included) already
 * carry their own networking stack, and this SDK shouldn't force a second,
 * possibly conflicting one on them. Swap this class for the host app's own
 * HTTP client if preferred; nothing else in the module depends on how the
 * bytes get there.
 */
internal class TelemetryApi(
    private val endpointUrl: String,
    private val apiKey: String?,
) {
    /**
     * @return an [UploadResult]. Throws nothing -- network/parse failures
     * come back as `UploadResult(accepted = false, remoteOptOutRequested = false)`.
     */
    fun uploadBatch(samples: List<Sample>): UploadResult {
        if (samples.isEmpty()) return UploadResult(accepted = true, remoteOptOutRequested = false)
        return try {
            val body = JSONArray(samples.map { it.toJson() }).toString()
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
            var remoteOptOut = false
            if (ok) {
                // `opt_out` (2026-09-02): a superadmin/admin left a pending
                // TelemetryRemoteOptOutRequest for this device (see the
                // backend's core/telemetry_admin.py "End & opt out" action)
                // -- the ONLY channel that exists for the backend to affect
                // this device's local opt-in state, since that preference
                // lives here on-device, not server-side. Tolerates a
                // response body that isn't valid JSON (or is missing the
                // key) by just treating it as false -- an older backend
                // without this field should never break uploads.
                val responseBody = try {
                    connection.inputStream?.bufferedReader()?.use { it.readText() }
                } catch (e: Exception) {
                    null
                }
                remoteOptOut = try {
                    responseBody?.let { JSONObject(it).optBoolean("opt_out", false) } ?: false
                } catch (e: Exception) {
                    false
                }
                Log.d(
                    TAG,
                    "Uploaded batch of ${samples.size} sample(s) -- HTTP $code" +
                        if (remoteOptOut) " (remote opt-out requested)" else "",
                )
            } else {
                // Read whatever the server said, if anything -- a 401/403 vs.
                // a 413/429 vs. a 4xx from a schema mismatch are all silent
                // otherwise, and this is exactly the kind of thing that's
                // invisible without a log line once this is wired to a real
                // backend during pilot/demo testing.
                val errorBody = try {
                    connection.errorStream?.bufferedReader()?.use { it.readText() }
                } catch (e: Exception) {
                    null
                }
                Log.w(TAG, "Upload rejected for ${endpointUrl} -- HTTP $code${errorBody?.let { ": $it" } ?: ""}")
            }
            connection.disconnect()
            UploadResult(accepted = ok, remoteOptOutRequested = remoteOptOut)
        } catch (e: Exception) {
            // Most common causes during dev/testing: the endpoint host is
            // unreachable (wrong IP/port, backend not running, or a
            // cleartext-HTTP block if network_security_config.xml wasn't
            // set up for this host), or a timeout.
            Log.w(TAG, "Upload to $endpointUrl failed: ${e.javaClass.simpleName}: ${e.message}")
            UploadResult(accepted = false, remoteOptOutRequested = false)
        }
    }

    private companion object {
        const val TAG = "NetTelemetry.Upload"
    }
}

/**
 * @param accepted true if the server accepted the batch (2xx).
 * @param remoteOptOutRequested true if the backend's response asked this
 * device to opt itself out -- see [TelemetryApi.uploadBatch]'s doc
 * comment. [UploadWorker] is what actually applies it.
 */
internal data class UploadResult(val accepted: Boolean, val remoteOptOutRequested: Boolean)

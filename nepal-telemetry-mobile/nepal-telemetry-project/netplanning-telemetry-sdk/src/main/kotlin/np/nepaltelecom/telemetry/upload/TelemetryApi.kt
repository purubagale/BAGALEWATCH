package np.nepaltelecom.telemetry.upload

import android.util.Log
import np.nepaltelecom.telemetry.model.Sample
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

private const val TAG = "NetTelemetry.Api"

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
     * [success] -- true if the server accepted the batch. This includes both
     * the normal `202 {"accepted": N, ...}` path and the `200
     * {"accepted": 0, "duplicate": true}` idempotent-retry path (mobile guide
     * §6) -- both mean "don't retry this batch," which is all the caller
     * needs to know.
     * [optOut] -- true when the response body carries `"opt_out": true`
     * (mobile guide §8.2): an admin has left a pending remote opt-out request
     * for one of this batch's devices. The caller (UploadWorker) is
     * responsible for acting on it -- this class only reports what the
     * server said.
     */
    data class UploadResult(val success: Boolean, val optOut: Boolean = false)

    fun uploadBatch(samples: List<Sample>): UploadResult {
        if (samples.isEmpty()) return UploadResult(success = true)
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
            val optOut = if (ok) {
                // errorStream is for 4xx/5xx; a 2xx/200 body comes through
                // inputStream. Malformed/empty bodies shouldn't fail an
                // otherwise-accepted upload -- they just can't carry an
                // opt_out instruction, so default to false.
                try {
                    val responseBody = connection.inputStream.bufferedReader().use { it.readText() }
                    JSONObject(responseBody).optBoolean("opt_out", false)
                } catch (e: Exception) {
                    false
                }
            } else {
                val errorBody = connection.errorStream?.bufferedReader()?.use { it.readText() }
                Log.w(TAG, "upload rejected: HTTP $code -> ${errorBody ?: "(no body)"} -- endpoint=$endpointUrl")
                false
            }
            connection.disconnect()
            UploadResult(success = ok, optOut = optOut)
        } catch (e: Exception) {
            // Most common causes, in the order worth checking for a "nothing
            // arrived" report: wrong host/port in TelemetryConfig.endpointUrl
            // (UnknownHostException / SocketTimeoutException), cleartext HTTP
            // blocked by network_security_config (ConnectException, or an
            // explicit CleartextNotPermittedException message), or the
            // backend simply not reachable from this device right now.
            Log.w(TAG, "upload failed before/without a response: ${e.javaClass.simpleName}: ${e.message} -- endpoint=$endpointUrl", e)
            UploadResult(success = false)
        }
    }
}

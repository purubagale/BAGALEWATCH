package np.nepaltelecom.telemetry.upload

import android.util.Log
import np.nepaltelecom.telemetry.model.VolteSample
import org.json.JSONArray
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

private const val TAG = "NetTelemetry.VolteApi"

/**
 * POSTs to /api/telemetry/v1/volte-samples/ (mobile guide §4.6 / §12). Kept
 * deliberately separate from [TelemetryApi] rather than generalized into one
 * shared class: different cadence (one call's worth per request, not a
 * periodic batch), and -- per §12.4 of the handoff doc -- no
 * opt_out/duplicate-detection handling on this endpoint at all, so sharing
 * [TelemetryApi]'s response-parsing logic would just be dead code here half
 * the time.
 */
internal class VolteApi(
    private val endpointUrl: String,
    private val apiKey: String?,
) {
    /** @return true if the server accepted the batch (2xx). Logs, rather than throws, on failure -- see TelemetryApi for why that matters for diagnosing a "nothing arrived" report. */
    fun uploadBatch(samples: List<VolteSample>): Boolean {
        if (samples.isEmpty()) return true
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
            if (!ok) {
                val errorBody = connection.errorStream?.bufferedReader()?.use { it.readText() }
                Log.w(TAG, "volte upload rejected: HTTP $code -> ${errorBody ?: "(no body)"} -- endpoint=$endpointUrl")
            }
            connection.disconnect()
            ok
        } catch (e: Exception) {
            Log.w(TAG, "volte upload failed before/without a response: ${e.javaClass.simpleName}: ${e.message} -- endpoint=$endpointUrl", e)
            false
        }
    }
}

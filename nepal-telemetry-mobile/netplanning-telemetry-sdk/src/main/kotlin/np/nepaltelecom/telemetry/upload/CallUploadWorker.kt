package np.nepaltelecom.telemetry.upload

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import np.nepaltelecom.telemetry.authorize
import np.nepaltelecom.telemetry.internalConfig
import np.nepaltelecom.telemetry.noteResponse
import np.nepaltelecom.telemetry.storage.CallQueue
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Sends finished calls to [np.nepaltelecom.telemetry.TelemetryConfig.callSamplesUrl]
 * (2026-10-14). Enqueued after each call with a network constraint, so a call
 * made without coverage is sent later. Calls are queued only while the user
 * shares, so what is queued is sent even if sharing has ended since; opting
 * out with the queue wiped clears it.
 */
internal class CallUploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val config = internalConfig ?: return Result.success()
        val url = config.callSamplesUrl ?: return Result.success()
        val queue = CallQueue(applicationContext)
        while (true) {
            val batch = queue.peek(BATCH_SIZE)
            if (batch.isEmpty()) return Result.success()
            val ok = try {
                val body = JSONArray(batch.map { r -> r.toJson() }).toString().toByteArray(StandardCharsets.UTF_8)
                val target = URL(url)
                val connection = (target.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    doOutput = true
                    connectTimeout = 15_000
                    readTimeout = 15_000
                }
                val signed = authorize(connection, target, "POST", body, config.apiKey)
                connection.outputStream.use { it.write(body) }
                val code = connection.responseCode
                noteResponse(signed, code)
                connection.disconnect()
                if (code !in 200..299) Log.w(TAG, "Call upload rejected -- HTTP $code")
                // A malformed batch (400/413) will not get better by retrying: drop it.
                // Anything else, a 404 from a server without this endpoint yet included,
                // keeps the calls queued for a later retry.
                code in 200..299 || code == 400 || code == 413
            } catch (e: Exception) {
                Log.w(TAG, "Call upload failed: ${e.javaClass.simpleName}: ${e.message}")
                false
            }
            if (!ok) return Result.retry()
            queue.removeFirst(batch.size)
            if (batch.size < BATCH_SIZE) return Result.success()
        }
    }

    private companion object {
        const val TAG = "NetTelemetry.Calls"
        const val BATCH_SIZE = 50
    }
}

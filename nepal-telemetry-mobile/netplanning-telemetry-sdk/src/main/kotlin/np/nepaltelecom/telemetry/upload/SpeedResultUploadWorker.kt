package np.nepaltelecom.telemetry.upload

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import np.nepaltelecom.telemetry.authorize
import np.nepaltelecom.telemetry.internalConfig
import np.nepaltelecom.telemetry.noteResponse
import np.nepaltelecom.telemetry.storage.SpeedResultQueue
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Sends held speed-test results to
 * [np.nepaltelecom.telemetry.TelemetryConfig.speedSamplesUrl] (2026-10-26),
 * one per request as the server expects, oldest first. Enqueued after each
 * test with a network constraint and backoff, so a result taken where
 * DT-WATCH cannot be reached goes once it can (on Wi-Fi or VPN today).
 */
internal class SpeedResultUploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val config = internalConfig ?: return Result.success()
        val url = config.speedSamplesUrl ?: return Result.success()
        val queue = SpeedResultQueue(applicationContext)
        repeat(MAX_PER_RUN) {
            val next = queue.peek(1).firstOrNull() ?: return Result.success()
            val ok = try {
                val body = next.toByteArray(StandardCharsets.UTF_8)
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
                if (code !in 200..299) Log.w(TAG, "Speed result rejected -- HTTP $code")
                // A malformed result (400/413) will not get better: drop it. Anything
                // else (no route, 404 on an older server, 429) keeps it for later.
                code in 200..299 || code == 400 || code == 413
            } catch (e: Exception) {
                Log.w(TAG, "Speed result upload failed: ${e.javaClass.simpleName}: ${e.message}")
                false
            }
            if (!ok) return Result.retry()
            queue.removeFirst(1)
        }
        // More than one run's worth left (the server takes 20 a minute): continue later.
        return if (queue.peek(1).isEmpty()) Result.success() else Result.retry()
    }

    private companion object {
        const val TAG = "NetTelemetry.Speed"
        const val MAX_PER_RUN = 15
    }
}

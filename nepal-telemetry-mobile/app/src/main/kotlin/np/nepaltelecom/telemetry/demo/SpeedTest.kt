package np.nepaltelecom.telemetry.demo

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.abs

/**
 * Active speed test (2026-10-05): ping, download and upload against the
 * dtwatch speedtest endpoints (core/speed_test.py). It runs only when the user
 * taps Start on the Signal screen, and it sends nothing about the device.
 * Results stay on the phone.
 *
 * Blocking calls: run it on a background thread.
 */
object SpeedTest {

    /** Same host as the telemetry endpoint in DemoApplication. */
    private const val BASE_URL = "https://dtwatch.ntc.net.np/api/telemetry/v1/speedtest/"

    private const val PING_COUNT = 10
    private const val DOWNLOAD_BYTES = 6 * 1024 * 1024
    private const val UPLOAD_BYTES = 2 * 1024 * 1024
    private const val CHUNK = 64 * 1024

    data class Result(
        val pingMedianMs: Double?,
        val jitterMs: Double?,
        val downloadMbps: Double?,
        val uploadMbps: Double?,
        val error: String?,
    )

    fun run(): Result = try {
        val pings = measurePings()
        Result(
            pingMedianMs = median(pings),
            jitterMs = jitter(pings),
            downloadMbps = measureDownloadMbps(),
            uploadMbps = measureUploadMbps(),
            error = null,
        )
    } catch (e: Exception) {
        Result(null, null, null, null, e.message ?: e.javaClass.simpleName)
    }

    /** Round-trip times in ms. The first is a warm-up and is dropped. */
    private fun measurePings(): List<Double> {
        val times = ArrayList<Double>(PING_COUNT)
        repeat(PING_COUNT + 1) {
            val start = System.nanoTime()
            val conn = open("ping/")
            try {
                val code = conn.responseCode
                if (code != HttpURLConnection.HTTP_NO_CONTENT) throw IOException("ping returned HTTP $code")
            } finally {
                conn.disconnect()
            }
            times.add((System.nanoTime() - start) / 1_000_000.0)
        }
        return times.drop(1)
    }

    /** Mbps from the time to read the whole body. */
    private fun measureDownloadMbps(): Double {
        val conn = open("download/?bytes=$DOWNLOAD_BYTES")
        val start = System.nanoTime()
        var received = 0L
        try {
            if (conn.responseCode != HttpURLConnection.HTTP_OK) throw IOException("download returned HTTP ${conn.responseCode}")
            conn.inputStream.use { input ->
                val buffer = ByteArray(CHUNK)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    received += n
                }
            }
        } finally {
            conn.disconnect()
        }
        return mbps(received, System.nanoTime() - start)
    }

    /** Mbps from the time until the server has taken every byte and replied. */
    private fun measureUploadMbps(): Double {
        val payload = ByteArray(CHUNK).also { java.util.Random().nextBytes(it) }
        val conn = open("upload/").apply {
            doOutput = true
            requestMethod = "POST"
            setFixedLengthStreamingMode(UPLOAD_BYTES.toLong())
            setRequestProperty("Content-Type", "application/octet-stream")
        }
        val start = System.nanoTime()
        try {
            conn.outputStream.use { out ->
                var sent = 0
                while (sent < UPLOAD_BYTES) {
                    out.write(payload)
                    sent += payload.size
                }
            }
            val code = conn.responseCode
            if (code != HttpURLConnection.HTTP_OK) throw IOException("upload returned HTTP $code")
        } finally {
            conn.disconnect()
        }
        return mbps(UPLOAD_BYTES.toLong(), System.nanoTime() - start)
    }

    private fun open(path: String): HttpURLConnection =
        (URL(BASE_URL + path).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 30_000
            useCaches = false
        }

    private fun mbps(bytes: Long, nanos: Long): Double {
        val seconds = nanos / 1_000_000_000.0
        return if (seconds <= 0) 0.0 else bytes * 8 / seconds / 1_000_000.0
    }

    private fun median(values: List<Double>): Double? {
        if (values.isEmpty()) return null
        val sorted = values.sorted()
        val mid = sorted.size / 2
        return if (sorted.size % 2 == 0) (sorted[mid - 1] + sorted[mid]) / 2 else sorted[mid]
    }

    /** Mean difference between consecutive pings: how much the latency swings. */
    private fun jitter(values: List<Double>): Double? {
        if (values.size < 2) return null
        return values.zipWithNext { a, b -> abs(b - a) }.average()
    }
}

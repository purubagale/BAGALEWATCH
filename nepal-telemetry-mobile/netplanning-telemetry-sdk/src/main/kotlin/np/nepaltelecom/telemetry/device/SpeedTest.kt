package np.nepaltelecom.telemetry.device

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Active speed test (2026-10-05; in the SDK since 2026-10-16): ping, download and upload against the
 * dtwatch speedtest endpoints (core/speed_test.py). It sends nothing about
 * the device.
 *
 * Over mobile data (2026-10-14): the test is meant to measure NTC's network,
 * so [runOnMobileData] asks Android for the mobile-data connection and sends
 * every request over it, even while the phone is on Wi-Fi. Android allows
 * that when mobile data is switched on. Packet loss is the share of pings
 * that got no answer within [PING_TIMEOUT_MS].
 *
 * Blocking calls: run it on a background thread.
 */
object SpeedTest {

    /** The speed test endpoints, next to the other device endpoints. */
    private fun baseUrl(): String = DeviceApi.baseUrl() + "speedtest/"

    private const val PING_COUNT = 20
    private const val PING_TIMEOUT_MS = 2_000
    private const val DOWNLOAD_BYTES = 6 * 1024 * 1024
    private const val UPLOAD_BYTES = 2 * 1024 * 1024
    private const val CHUNK = 64 * 1024
    private const val MOBILE_WAIT_S = 10L

    data class Result(
        val pingMedianMs: Double?,
        val jitterMs: Double?,
        val packetLossPct: Double?,
        val downloadMbps: Double?,
        val uploadMbps: Double?,
        val error: String?,
        /** True when the test went over mobile data, false when over Wi-Fi or another network. */
        val onMobileData: Boolean = false,
        /** True when the test went over Wi-Fi (2026-10-15). */
        val onWifi: Boolean = false,
    ) {
        /** The connection the test used, as sent to NTC: "mobile", "wifi" or "" when unknown. */
        val bearer: String get() = when {
            onMobileData -> "mobile"
            onWifi -> "wifi"
            else -> ""
        }
    }

    /**
     * Runs the test over mobile data. When mobile data cannot be reached
     * (switched off, no SIM), runs it over the current connection if
     * [fallback] is true, else returns null.
     */
    fun runOnMobileData(context: Context, fallback: Boolean): Result? {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val active = cm?.getNetworkCapabilities(cm.activeNetwork)
        val alreadyMobile = active?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true &&
            !active.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        if (alreadyMobile) return run(null).copy(onMobileData = true)
        val mobile = cm?.let { requestTransport(it, NetworkCapabilities.TRANSPORT_CELLULAR) }
        if (mobile == null) {
            if (!fallback) return null
            val onWifi = active?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
            return run(null).copy(onWifi = onWifi)
        }
        return try {
            run(mobile.first).copy(onMobileData = true)
        } finally {
            runCatching { cm.unregisterNetworkCallback(mobile.second) }
        }
    }

    /**
     * Runs the test over Wi-Fi (2026-10-15), even while mobile data is the
     * active connection. Returns null when the phone is not on Wi-Fi.
     */
    fun runOnWifi(context: Context): Result? {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return null
        val active = cm.getNetworkCapabilities(cm.activeNetwork)
        if (active?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true) return run(null).copy(onWifi = true)
        val wifi = requestTransport(cm, NetworkCapabilities.TRANSPORT_WIFI) ?: return null
        return try {
            run(wifi.first).copy(onWifi = true)
        } finally {
            runCatching { cm.unregisterNetworkCallback(wifi.second) }
        }
    }

    /** Asks Android for a connection of one kind; waits up to [MOBILE_WAIT_S]. */
    private fun requestTransport(cm: ConnectivityManager, transport: Int): Pair<Network, ConnectivityManager.NetworkCallback>? {
        val latch = CountDownLatch(1)
        var network: Network? = null
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(n: Network) {
                network = n
                latch.countDown()
            }
        }
        val request = NetworkRequest.Builder()
            .addTransportType(transport)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        try {
            cm.requestNetwork(request, callback)
        } catch (_: Exception) {
            return null
        }
        latch.await(MOBILE_WAIT_S, TimeUnit.SECONDS)
        val n = network
        if (n == null) {
            runCatching { cm.unregisterNetworkCallback(callback) }
            return null
        }
        return n to callback
    }

    fun run(network: Network? = null): Result = try {
        val pings = measurePings(network)
        val answered = pings.filterNotNull()
        if (answered.isEmpty()) throw IOException("no answer from the server")
        Result(
            pingMedianMs = median(answered),
            jitterMs = jitter(answered),
            packetLossPct = 100.0 * (pings.size - answered.size) / pings.size,
            downloadMbps = measureDownloadMbps(network),
            uploadMbps = measureUploadMbps(network),
            error = null,
        )
    } catch (e: Exception) {
        Result(null, null, null, null, null, friendlyErrorMessage(e))
    }

    /** Round-trip times in ms, null for a ping with no answer in time. The first is a warm-up and is dropped. */
    private fun measurePings(network: Network?): List<Double?> {
        val times = ArrayList<Double?>(PING_COUNT)
        repeat(PING_COUNT + 1) { i ->
            val start = System.nanoTime()
            val conn = open("ping/", network).apply {
                if (i > 0) {
                    connectTimeout = PING_TIMEOUT_MS
                    readTimeout = PING_TIMEOUT_MS
                }
            }
            val ms = try {
                if (conn.responseCode == HttpURLConnection.HTTP_NO_CONTENT) (System.nanoTime() - start) / 1_000_000.0 else null
            } catch (e: IOException) {
                if (i == 0) throw e  // the server can't be reached at all
                null
            } finally {
                conn.disconnect()
            }
            if (i > 0) times.add(ms)
        }
        return times
    }

    /** Mbps from the time to read the whole body. */
    private fun measureDownloadMbps(network: Network?): Double {
        val conn = open("download/?bytes=$DOWNLOAD_BYTES", network)
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
    private fun measureUploadMbps(network: Network?): Double {
        val payload = ByteArray(CHUNK).also { java.util.Random().nextBytes(it) }
        val conn = open("upload/", network).apply {
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

    private fun open(path: String, network: Network?): HttpURLConnection {
        val url = URL(baseUrl() + path)
        val conn = (network?.openConnection(url) ?: url.openConnection()) as HttpURLConnection
        return conn.apply {
            connectTimeout = 10_000
            readTimeout = 30_000
            useCaches = false
        }
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

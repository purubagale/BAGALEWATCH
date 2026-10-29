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
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs

/**
 * Active speed test (2026-10-05; in the SDK since 2026-10-16): ping, download and upload. It sends
 * nothing about the device.
 *
 * Since 2026-10-26 it works the way LibreSpeed and Ookla do, so its numbers
 * are comparable with theirs: several connections at once, each running for
 * a fixed time, with the first [Profile.graceMs] left out (TCP is still
 * speeding up then), and the result is the sustained rate. The far end is
 * served by nginx itself on the dtwatch server (`/speedtest/empty`,
 * `/speedtest/garbage`, `/speedtest/upload`), not by Django, so parallel
 * streams don't hold up the web app. A server without those paths gets the
 * old single-connection test against core/speed_test.py.
 *
 * [Profile.FULL] is for a test someone starts; [Profile.LIGHT] for scheduled
 * and automatic tests (Collector, problem reports), which must stay small on
 * a subscriber's data.
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

    enum class Profile(
        val downStreams: Int, val upStreams: Int, val durationMs: Long, val graceMs: Long,
        val downCapBytes: Long, val upCapBytes: Long,
    ) {
        FULL(6, 4, 10_000, 1_500, 150L * 1024 * 1024, 60L * 1024 * 1024),
        LIGHT(3, 2, 5_000, 1_000, 15L * 1024 * 1024, 6L * 1024 * 1024),
    }

    /** The old Django endpoints, next to the other device endpoints. */
    private fun legacyBaseUrl(): String = DeviceApi.baseUrl() + "speedtest/"

    /**
     * Where the test runs (2026-10-26): the address DT-WATCH last named at
     * `speedtest/config/` (a public machine once there is one), else the
     * nginx-served `/speedtest/` at the root of the DT-WATCH server itself.
     */
    private fun baseUrl(): String {
        savedBase()?.let { return it }
        val u = URL(DeviceApi.baseUrl())
        return "${u.protocol}://${u.authority}/speedtest/"
    }

    @Volatile private var appContext: Context? = null

    private fun prefs() = appContext?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun savedBase(): String? = prefs()?.getString(KEY_BASE, null)?.takeIf { it.startsWith("http") }

    /**
     * Asks DT-WATCH where to test and remembers the answer; a short wait, and
     * any failure keeps the address remembered before (2026-10-26).
     */
    private fun refreshServer(network: Network?) {
        val prefs = prefs() ?: return
        try {
            val conn = open(legacyBaseUrl() + "config/", network).apply {
                connectTimeout = 3_000
                readTimeout = 3_000
            }
            try {
                if (conn.responseCode == HttpURLConnection.HTTP_OK) {
                    val text = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
                    val base = org.json.JSONObject(text).optString("base_url", "")
                    prefs.edit().apply {
                        if (base.startsWith("http")) putString(KEY_BASE, if (base.endsWith("/")) base else "$base/") else remove(KEY_BASE)
                    }.apply()
                }
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            // Not reachable now: keep what was remembered.
        }
    }

    private const val PREFS = "netplanning_speedtest"
    private const val KEY_BASE = "base_url"

    private const val PING_COUNT = 20
    private const val PING_TIMEOUT_MS = 2_000
    private const val LEGACY_DOWNLOAD_BYTES = 6 * 1024 * 1024
    private const val LEGACY_UPLOAD_BYTES = 2 * 1024 * 1024
    private const val UPLOAD_REQUEST_BYTES = 8L * 1024 * 1024
    private const val CHUNK = 64 * 1024
    private const val MOBILE_WAIT_S = 10L
    private const val LOADED_PING_GAP_MS = 250L
    private const val LOADED_PING_TIMEOUT_MS = 3_000

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
        /** How it was measured, e.g. "multi 6x10s" or "single" (2026-10-26). */
        val method: String = "",
        /** True when the test server could not be reached at all (2026-10-26). */
        val unreachable: Boolean = false,
        /**
         * Loaded latency (2026-10-29, like Ookla): median ping while the
         * download runs, and while the upload runs. A line that is quick when
         * idle but slow under load makes calls and games lag.
         */
        val latencyDownMs: Double? = null,
        val latencyUpMs: Double? = null,
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
    fun runOnMobileData(context: Context, fallback: Boolean, profile: Profile = Profile.FULL): Result? =
        runOnMobileDataInner(context, fallback, profile)?.let { r ->
            // Plain words for the case seen today: the test server is not
            // reachable from the mobile data network yet (2026-10-26).
            if (r.unreachable && r.onMobileData) {
                r.copy(error = "The speed test server cannot be reached over mobile data yet. Try again on Wi-Fi.")
            } else r
        }

    private fun runOnMobileDataInner(context: Context, fallback: Boolean, profile: Profile): Result? {
        appContext = context.applicationContext
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val active = cm?.getNetworkCapabilities(cm.activeNetwork)
        val alreadyMobile = active?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true &&
            !active.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        if (alreadyMobile) return run(null, profile).copy(onMobileData = true)
        val mobile = cm?.let { requestTransport(it, NetworkCapabilities.TRANSPORT_CELLULAR) }
        if (mobile == null) {
            if (!fallback) return null
            val onWifi = active?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
            return run(null, profile).copy(onWifi = onWifi)
        }
        return try {
            run(mobile.first, profile).copy(onMobileData = true)
        } finally {
            runCatching { cm.unregisterNetworkCallback(mobile.second) }
        }
    }

    /**
     * Runs the test over Wi-Fi (2026-10-15), even while mobile data is the
     * active connection. Returns null when the phone is not on Wi-Fi.
     */
    fun runOnWifi(context: Context, profile: Profile = Profile.FULL): Result? {
        appContext = context.applicationContext
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return null
        val active = cm.getNetworkCapabilities(cm.activeNetwork)
        if (active?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true) return run(null, profile).copy(onWifi = true)
        val wifi = requestTransport(cm, NetworkCapabilities.TRANSPORT_WIFI) ?: return null
        return try {
            run(wifi.first, profile).copy(onWifi = true)
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

    fun run(network: Network? = null, profile: Profile = Profile.FULL, context: Context? = null): Result = try {
        context?.let { appContext = it.applicationContext }
        refreshServer(network)
        if (newEndpointsAvailable(network)) {
            val pings = measurePings(network, baseUrl() + "empty")
            val answered = pings.filterNotNull()
            val (down, latencyDown) = withLoadedPings(network, baseUrl() + "empty") { measureDownloadMulti(network, profile) }
            val (up, latencyUp) = withLoadedPings(network, baseUrl() + "empty") { measureUploadMulti(network, profile) }
            Result(
                pingMedianMs = median(answered),
                jitterMs = jitter(answered),
                packetLossPct = 100.0 * (pings.size - answered.size) / pings.size,
                downloadMbps = down,
                uploadMbps = up,
                error = null,
                method = "multi ${profile.downStreams}x${profile.durationMs / 1000}s",
                latencyDownMs = latencyDown,
                latencyUpMs = latencyUp,
            )
        } else {
            val pings = measurePings(network, legacyBaseUrl() + "ping/")
            val answered = pings.filterNotNull()
            Result(
                pingMedianMs = median(answered),
                jitterMs = jitter(answered),
                packetLossPct = 100.0 * (pings.size - answered.size) / pings.size,
                downloadMbps = measureDownloadLegacy(network),
                uploadMbps = measureUploadLegacy(network),
                error = null,
                method = "single",
            )
        }
    } catch (e: Exception) {
        Result(null, null, null, null, null, friendlyErrorMessage(e),
            unreachable = e is java.net.ConnectException || e is java.net.SocketTimeoutException ||
                e is java.net.UnknownHostException || e is java.net.NoRouteToHostException)
    }

    /** True when the server answers the nginx ping; a 404 means an older server. */
    private fun newEndpointsAvailable(network: Network?): Boolean {
        val conn = open(baseUrl() + "empty?r=${System.nanoTime()}", network)
        return try {
            conn.responseCode == HttpURLConnection.HTTP_NO_CONTENT
        } catch (e: IOException) {
            false
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Runs [block] (a download or upload) while a second thread pings the
     * server every [LOADED_PING_GAP_MS]; returns the block's result and the
     * median of the pings answered meanwhile (null when none was).
     */
    private fun <T> withLoadedPings(network: Network?, url: String, block: () -> T): Pair<T, Double?> {
        val rtts = java.util.Collections.synchronizedList(ArrayList<Double>())
        val running = java.util.concurrent.atomic.AtomicBoolean(true)
        val pinger = Thread {
            while (running.get()) {
                val start = System.nanoTime()
                val conn = open("$url?r=${System.nanoTime()}", network).apply {
                    connectTimeout = LOADED_PING_TIMEOUT_MS
                    readTimeout = LOADED_PING_TIMEOUT_MS
                }
                try {
                    if (conn.responseCode == HttpURLConnection.HTTP_NO_CONTENT) rtts.add((System.nanoTime() - start) / 1_000_000.0)
                } catch (_: IOException) {
                    // An unanswered ping under load is left out of the median.
                } finally {
                    conn.disconnect()
                }
                try {
                    Thread.sleep(LOADED_PING_GAP_MS)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }.apply { isDaemon = true; start() }
        try {
            val result = block()
            return result to median(synchronized(rtts) { rtts.toList() })
        } finally {
            running.set(false)
            pinger.interrupt()
        }
    }

    /** Round-trip times in ms, null for a ping with no answer in time. The first is a warm-up and is dropped. */
    private fun measurePings(network: Network?, url: String): List<Double?> {
        val times = ArrayList<Double?>(PING_COUNT)
        repeat(PING_COUNT + 1) { i ->
            val start = System.nanoTime()
            val conn = open("$url${if (url.contains('?')) '&' else '?'}r=${System.nanoTime()}", network).apply {
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

    /**
     * Sustained download rate: [Profile.downStreams] connections fetch the
     * server's random file again and again until the time is up or the cap
     * is reached; only bytes after [Profile.graceMs] count.
     */
    private fun measureDownloadMulti(network: Network?, p: Profile): Double = timedStreams(p.downStreams, p, p.downCapBytes) { total, stop ->
        val buffer = ByteArray(CHUNK)
        while (!stop()) {
            val conn = open(baseUrl() + "garbage?r=${System.nanoTime()}", network)
            try {
                if (conn.responseCode != HttpURLConnection.HTTP_OK) throw IOException("download returned HTTP ${conn.responseCode}")
                conn.inputStream.use { input ->
                    while (!stop()) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        total.addAndGet(n.toLong())
                    }
                }
            } finally {
                conn.disconnect()
            }
        }
    }.also { if (it.second == 0L) throw IOException("No data came back from the speed test server") }.first

    /** Sustained upload rate, the same way: random data posted on several connections. */
    private fun measureUploadMulti(network: Network?, p: Profile): Double = timedStreams(p.upStreams, p, p.upCapBytes) { total, stop ->
        val payload = ByteArray(CHUNK).also { java.util.Random().nextBytes(it) }
        while (!stop()) {
            // Chunked, so a request can end as soon as the time is up without
            // sending filler to complete a fixed length.
            val conn = open(baseUrl() + "upload?r=${System.nanoTime()}", network).apply {
                doOutput = true
                requestMethod = "POST"
                setChunkedStreamingMode(CHUNK)
                setRequestProperty("Content-Type", "application/octet-stream")
            }
            try {
                var sent = 0L
                conn.outputStream.use { out ->
                    while (sent < UPLOAD_REQUEST_BYTES && !stop()) {
                        out.write(payload)
                        sent += payload.size
                        total.addAndGet(payload.size.toLong())
                    }
                }
                conn.responseCode
            } catch (e: IOException) {
                if (!stop()) throw e
            } finally {
                conn.disconnect()
            }
        }
    }.first

    /**
     * Runs [streams] workers for [Profile.durationMs] (or until the byte cap
     * for that direction), counts bytes in [AtomicLong], and returns the Mbps
     * over the time after [Profile.graceMs], with the total bytes moved.
     */
    private fun timedStreams(
        streams: Int, p: Profile, cap: Long,
        worker: (total: AtomicLong, stop: () -> Boolean) -> Unit,
    ): Pair<Double, Long> {
        val total = AtomicLong(0)
        val start = System.nanoTime()
        val deadline = start + p.durationMs * 1_000_000
        val stop = { System.nanoTime() >= deadline || total.get() >= cap }
        val pool = Executors.newFixedThreadPool(streams)
        val errors = AtomicLong(0)
        var firstError: Exception? = null
        repeat(streams) {
            pool.execute {
                try {
                    worker(total, stop)
                } catch (e: Exception) {
                    if (errors.incrementAndGet() == 1L) firstError = e
                }
            }
        }
        // Mark the byte count when the start-up time is over.
        val graceAt = start + p.graceMs * 1_000_000
        while (System.nanoTime() < graceAt && !stop()) Thread.sleep(20)
        val graceBytes = total.get()
        val graceTime = System.nanoTime()
        pool.shutdown()
        pool.awaitTermination(p.durationMs + 15_000, TimeUnit.MILLISECONDS)
        pool.shutdownNow()
        val endTime = minOf(System.nanoTime(), deadline)
        val moved = total.get()
        if (moved == 0L && errors.get() >= streams) throw firstError ?: IOException("Speed test failed")
        // Very short tests (cap reached during start-up) fall back to the whole time.
        return if (moved > graceBytes && endTime > graceTime) {
            mbps(moved - graceBytes, endTime - graceTime) to moved
        } else {
            mbps(moved, maxOf(1L, endTime - start)) to moved
        }
    }

    /** Old single-connection download against core/speed_test.py. */
    private fun measureDownloadLegacy(network: Network?): Double {
        val conn = open(legacyBaseUrl() + "download/?bytes=$LEGACY_DOWNLOAD_BYTES", network)
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

    /** Old single-connection upload against core/speed_test.py. */
    private fun measureUploadLegacy(network: Network?): Double {
        val payload = ByteArray(CHUNK).also { java.util.Random().nextBytes(it) }
        val conn = open(legacyBaseUrl() + "upload/", network).apply {
            doOutput = true
            requestMethod = "POST"
            setFixedLengthStreamingMode(LEGACY_UPLOAD_BYTES.toLong())
            setRequestProperty("Content-Type", "application/octet-stream")
        }
        val start = System.nanoTime()
        try {
            conn.outputStream.use { out ->
                var sent = 0
                while (sent < LEGACY_UPLOAD_BYTES) {
                    out.write(payload)
                    sent += payload.size
                }
            }
            val code = conn.responseCode
            if (code != HttpURLConnection.HTTP_OK) throw IOException("upload returned HTTP $code")
        } finally {
            conn.disconnect()
        }
        return mbps(LEGACY_UPLOAD_BYTES.toLong(), System.nanoTime() - start)
    }

    private fun open(url: String, network: Network?): HttpURLConnection {
        val u = URL(url)
        val conn = (network?.openConnection(u) ?: u.openConnection()) as HttpURLConnection
        return conn.apply {
            connectTimeout = 10_000
            readTimeout = 30_000
            useCaches = false
            setRequestProperty("Cache-Control", "no-cache")
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

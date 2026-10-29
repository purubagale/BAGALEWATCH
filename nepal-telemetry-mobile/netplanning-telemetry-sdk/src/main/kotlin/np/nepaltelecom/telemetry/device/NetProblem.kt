package np.nepaltelecom.telemetry.device

import android.content.Context
import android.os.Build
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.model.RadioBand
import np.nepaltelecom.telemetry.model.Sample
import np.nepaltelecom.telemetry.storage.HardwareInfo
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * "Report a problem" without any screen (2026-10-14; in the SDK since
 * 2026-10-16). The host app asks what is wrong; [send] then reads the signal
 * with the phone's position, runs a speed test over mobile data, and sends
 * all of it to NTC as one report (the server's core/problem_report.py).
 * Only a registered phone can send. Blocking: call it off the main thread.
 */
object NetProblem {

    /** The categories the server accepts, with an English label for a picker. */
    val CATEGORIES: List<Pair<String, String>> = listOf(
        "no_signal" to "No signal",
        "slow_data" to "Slow data",
        "call_drop" to "Calls drop",
        "stuck_2g3g" to "Phone stays on 2G/3G",
        "other" to "Something else",
    )

    private const val READ_WAIT_S = 30L
    private const val NOTE_MAX = 500

    /**
     * What happened. [sent] is true when the server took the report.
     * [hint] is a plain explanation of the reading for the user, from
     * [ProblemHints]; [error] a message safe to show when not sent.
     */
    data class Outcome(
        val sent: Boolean,
        val notRegistered: Boolean = false,
        val noLocation: Boolean = false,
        val error: String? = null,
        val hint: String? = null,
        val sample: Sample? = null,
        val speed: SpeedTest.Result? = null,
        /** Set when the person chose to share until the problem is fixed and the server started it. */
        val share: Share? = null,
    )

    /**
     * The customer's own sharing for this report (2026-10-29): the host app
     * sends signal and place to [traceId] every [intervalMs] until
     * [expiresAtMs], until NTC closes the complaint (the server then answers
     * 409), or until the person stops it.
     */
    data class Share(val traceId: String, val expiresAtMs: Long, val intervalMs: Long)

    fun send(
        context: Context, category: String, note: String, withSpeedTest: Boolean = true,
        shareUntilFixed: Boolean = false,
    ): Outcome {
        val app = context.applicationContext
        if (!NetTelemetry.isSupported()) return Outcome(sent = false, error = NetDevice.UNSUPPORTED_MESSAGE)
        if (!NetDevice.isRegistered(app)) return Outcome(sent = false, notRegistered = true)
        require(CATEGORIES.any { it.first == category }) { "unknown category $category" }
        val latch = CountDownLatch(1)
        var sample: Sample? = null
        NetTelemetry.readLiveSample { sample = it; latch.countDown() }
        latch.await(READ_WAIT_S, TimeUnit.SECONDS)
        val s = sample
        val speed = if (withSpeedTest) SpeedTest.runOnMobileData(app, fallback = false, profile = SpeedTest.Profile.LIGHT) else null
        if (s?.lat == null || s.lon == null) return Outcome(sent = false, noLocation = true, sample = s, speed = speed)
        return try {
            val body = body(app, category, note.take(NOTE_MAX), s, speed)
            if (shareUntilFixed) body.put("share_until_fixed", true)
            val answer = DeviceApi.reportProblem(body.toString())
            Outcome(sent = true, hint = ProblemHints.explain(s, speed), sample = s, speed = speed, share = parseShare(answer))
        } catch (e: Exception) {
            Outcome(sent = false, error = friendlyErrorMessage(e), sample = s, speed = speed)
        }
    }

    private fun parseShare(answer: String): Share? = runCatching {
        val share = JSONObject(answer).optJSONObject("share") ?: return null
        val expires = java.time.OffsetDateTime.parse(share.getString("expires_at")).toInstant().toEpochMilli()
        Share(share.getString("trace_id"), expires, share.optLong("interval_s", 300L) * 1000L)
    }.getOrNull()

    /** The JSON the server expects for one report. */
    fun body(context: Context, category: String, note: String, s: Sample, speed: SpeedTest.Result?): JSONObject =
        JSONObject().apply {
            put("category", category)
            put("note", note)
            put("ts", System.currentTimeMillis())
            put("lat", s.lat)
            put("lon", s.lon)
            put("network_type", s.networkType)
            RadioBand.label(s.networkType, s.band, if (s.networkType == "GSM") s.bcch ?: s.arfcn else s.arfcn)
                ?.let { put("band", it) }
            s.pci?.let { put("pci", it) }
            if (s.networkType == "LTE") s.cellId?.let { put("cell_id", it) }
            ProblemHints.level(s)?.let { put("level_dbm", it) }
            s.rsrqDb?.let { put("rsrq_db", it) }
            s.sinrDb?.let { put("sinr_db", it) }
            // Outdoors, indoors or in a vehicle when reported (2026-10-26, collector/Environment.kt).
            s.environment?.let { put("environment", it) }
            s.environmentSource?.let { put("environment_source", it) }
            if (speed != null && speed.error == null) {
                speed.downloadMbps?.let { put("download_mbps", it) }
                speed.uploadMbps?.let { put("upload_mbps", it) }
                speed.pingMedianMs?.let { put("ping_ms", it) }
                speed.jitterMs?.let { put("jitter_ms", it) }
                speed.packetLossPct?.let { put("packet_loss_pct", it) }
            }
            put("phone_model", "${Build.MANUFACTURER} ${Build.MODEL}".take(80))
            put("android_version", Build.VERSION.RELEASE)
            put("app_version", HardwareInfo.appVersion(context))
        }
}

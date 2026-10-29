package np.nepaltelecom.telemetry.device

import np.nepaltelecom.telemetry.model.Sample

/**
 * A plain answer to "why is my connection bad here?" (2026-10-14), worked out
 * on the phone from its own reading and speed test. The same simple rules the
 * server's problem check uses, with the same limits; keep them in step with
 * core/problem_report.py. Nothing is sent anywhere.
 */
object ProblemHints {

    private val WEAK_DBM = mapOf("4G" to -110, "3G" to -105, "2G" to -100)
    private val GOOD_DBM = mapOf("4G" to -100, "3G" to -95, "2G" to -85)
    private const val BAD_RSRQ_DB = -15
    private const val BAD_SINR_DB = 0
    private const val SLOW_DL_MBPS = 2.0
    private const val HIGH_PING_MS = 150.0
    private const val HIGH_LOSS_PCT = 5.0
    private const val HIGH_LOADED_MS = 400.0

    private fun tech(networkType: String?): String? = when (networkType) {
        "LTE", "NR" -> "4G"
        "UMTS" -> "3G"
        "GSM" -> "2G"
        else -> null
    }

    fun level(s: Sample): Int? = when (s.networkType) {
        "UMTS" -> s.rscpDbm
        "GSM" -> s.rssiDbm
        else -> s.rsrpDbm
    }

    fun explain(s: Sample?, speed: SpeedTest.Result?): String {
        val lines = mutableListOf<String>()
        if (speed != null && speed.error == null && !speed.onMobileData) {
            lines += "This test ran over Wi-Fi because mobile data is off, so it measured your Wi-Fi, not NTC's network."
        }
        val t = tech(s?.networkType)
        val level = s?.let { level(it) }
        if (s == null || t == null || level == null) {
            lines += "No signal reading right now. Check that location is switched on for the app."
            return lines.joinToString("\n")
        }
        val slow = speed != null && speed.error == null && speed.onMobileData && (
            (speed.downloadMbps ?: Double.MAX_VALUE) < SLOW_DL_MBPS ||
                (speed.pingMedianMs ?: 0.0) > HIGH_PING_MS ||
                (speed.packetLossPct ?: 0.0) >= HIGH_LOSS_PCT
            )
        val weak = level < WEAK_DBM.getValue(t)
        val good = level >= GOOD_DBM.getValue(t)
        val noisy = good && ((s.rsrqDb ?: 0) <= BAD_RSRQ_DB || (s.sinrDb ?: 99) < BAD_SINR_DB)
        when {
            weak -> lines += "The signal here is weak ($level dBm). Near a window or outdoors it is usually better. " +
                "Reporting the problem shows NTC this spot."
            noisy -> lines += "The signal is strong but noisy here: other cells are interfering. Reporting the " +
                "problem helps NTC find it."
            slow && good -> lines += "The signal is good but the speed is low: the network is probably busy here " +
                "right now."
            slow -> lines += "The speed is low and the signal is only fair here."
        }
        // Loaded latency (2026-10-29): quick when idle, slow while data flows.
        val loaded = listOfNotNull(speed?.latencyDownMs, speed?.latencyUpMs).maxOrNull()
        if (speed != null && speed.error == null && speed.onMobileData && loaded != null && loaded > HIGH_LOADED_MS &&
            (speed.pingMedianMs ?: 0.0) <= HIGH_PING_MS
        ) {
            lines += "The delay rises to ${loaded.toInt()} ms while data is moving (it is ${speed.pingMedianMs?.toInt() ?: "—"} ms " +
                "when idle). Calls, video calls and games may lag even though the speed is fine."
        }
        if (t != "4G") {
            lines += "Your phone is on $t. If 4G is available here, check that the network mode is set to 4G/LTE " +
                "and that your SIM is a 4G SIM."
        }
        if (lines.isEmpty()) lines += "Signal${if (speed?.error == null && speed != null) " and speed" else ""} look normal here."
        return lines.joinToString("\n")
    }
}

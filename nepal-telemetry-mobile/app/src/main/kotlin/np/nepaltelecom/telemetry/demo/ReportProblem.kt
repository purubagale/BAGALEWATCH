package np.nepaltelecom.telemetry.demo

import android.os.Build
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.model.RadioBand
import np.nepaltelecom.telemetry.model.Sample
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * "Report a problem" (2026-10-14). The person picks what is wrong and may add
 * a note; the app then reads the signal with the phone's position, runs a
 * speed test over mobile data, and sends all of it to NTC as one report
 * (core/problem_report.py). Only a registered phone can send, and only when
 * the person taps Send. Afterwards it shows a plain explanation from
 * [ProblemHints].
 */
object ReportProblem {

    private val CATEGORIES = listOf(
        "no_signal" to "No signal",
        "slow_data" to "Slow data",
        "call_drop" to "Calls drop",
        "stuck_2g3g" to "Phone stays on 2G/3G",
        "other" to "Something else",
    )
    private const val READ_WAIT_S = 30L

    fun start(activity: AppCompatActivity) {
        if (!Registration.isRegistered(activity)) {
            Toast.makeText(activity, R.string.report_register_first, Toast.LENGTH_LONG).show()
            RegisterPrompt.ask(activity)
            return
        }
        var chosen = -1
        val note = EditText(activity).apply {
            hint = activity.getString(R.string.report_note_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            maxLines = 4
        }
        val box = LinearLayout(activity).apply {
            setPadding(48, 8, 48, 0)
            addView(note)
        }
        AlertDialog.Builder(activity)
            .setTitle(R.string.report_title)
            .setSingleChoiceItems(CATEGORIES.map { it.second }.toTypedArray(), -1) { _, which -> chosen = which }
            .setView(box)
            .setPositiveButton(R.string.report_send) { _, _ ->
                if (chosen < 0) {
                    Toast.makeText(activity, R.string.report_choose, Toast.LENGTH_SHORT).show()
                } else {
                    send(activity, CATEGORIES[chosen].first, note.text.toString().take(500))
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun send(activity: AppCompatActivity, category: String, note: String) {
        val progress = AlertDialog.Builder(activity)
            .setMessage(R.string.report_measuring)
            .setCancelable(false)
            .show()
        Thread {
            val latch = CountDownLatch(1)
            var sample: Sample? = null
            NetTelemetry.readLiveSample { sample = it; latch.countDown() }
            latch.await(READ_WAIT_S, TimeUnit.SECONDS)
            val s = sample
            val speed = SpeedTest.runOnMobileData(activity, fallback = false)
            val message = if (s?.lat == null || s.lon == null) {
                activity.getString(R.string.report_no_location)
            } else {
                try {
                    TraceApi.reportProblem(body(activity, category, note, s, speed).toString())
                    activity.getString(R.string.report_sent) + "\n\n" + ProblemHints.explain(s, speed)
                } catch (e: Exception) {
                    activity.getString(R.string.report_failed, friendlyErrorMessage(e))
                }
            }
            activity.runOnUiThread {
                progress.dismiss()
                if (!activity.isFinishing) {
                    AlertDialog.Builder(activity)
                        .setTitle(R.string.report_title)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, null)
                        .show()
                }
            }
        }.start()
    }

    private fun body(activity: AppCompatActivity, category: String, note: String, s: Sample, speed: SpeedTest.Result?) =
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
            if (speed != null && speed.error == null) {
                speed.downloadMbps?.let { put("download_mbps", it) }
                speed.uploadMbps?.let { put("upload_mbps", it) }
                speed.pingMedianMs?.let { put("ping_ms", it) }
                speed.jitterMs?.let { put("jitter_ms", it) }
                speed.packetLossPct?.let { put("packet_loss_pct", it) }
            }
            put("phone_model", "${Build.MANUFACTURER} ${Build.MODEL}".take(80))
            put("android_version", Build.VERSION.RELEASE)
            put("app_version", runCatching {
                activity.packageManager.getPackageInfo(activity.packageName, 0).versionName
            }.getOrNull() ?: "")
        }
}

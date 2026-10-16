package np.nepaltelecom.telemetry.demo

import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import np.nepaltelecom.telemetry.device.NetProblem

/**
 * "Report a problem" (2026-10-14). The person picks what is wrong and may add
 * a note; the SDK ([NetProblem], since 2026-10-16) then reads the signal with
 * the phone's position, runs a speed test over mobile data, and sends all of
 * it to NTC as one report. Only a registered phone can send, and only when
 * the person taps Send. Afterwards it shows a plain explanation of the
 * reading.
 */
object ReportProblem {

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
            .setSingleChoiceItems(NetProblem.CATEGORIES.map { it.second }.toTypedArray(), -1) { _, which -> chosen = which }
            .setView(box)
            .setPositiveButton(R.string.report_send) { _, _ ->
                if (chosen < 0) {
                    Toast.makeText(activity, R.string.report_choose, Toast.LENGTH_SHORT).show()
                } else {
                    send(activity, NetProblem.CATEGORIES[chosen].first, note.text.toString())
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
            val outcome = NetProblem.send(activity, category, note)
            val message = when {
                outcome.sent -> activity.getString(R.string.report_sent) + "\n\n" + outcome.hint.orEmpty()
                outcome.notRegistered -> activity.getString(R.string.report_register_first)
                outcome.noLocation -> activity.getString(R.string.report_no_location)
                else -> activity.getString(R.string.report_failed, outcome.error.orEmpty())
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
}

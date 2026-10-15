package np.nepaltelecom.telemetry.demo

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import org.json.JSONObject

/**
 * Proving the registered number by SMS code (2026-10-15). The number is
 * typed at registration, so on its own it proves nothing: someone could
 * type another person's number. When the server can send SMS, it says so in
 * its answer to registration; the app then asks for the code it sent to
 * that number. Until NTC's SMS gateway is set up the server says it cannot,
 * and nothing is asked.
 *
 * What this phone knows is kept with the registration flag, and refreshed
 * from the server each time Settings opens.
 */
object NumberVerify {

    private const val KEY_VERIFIED = "number_verified"
    private const val KEY_AVAILABLE = "number_verify_available"

    private fun prefs(context: Context) =
        context.getSharedPreferences(TraceRequestsPanel.PREFS, Context.MODE_PRIVATE)

    fun isVerified(context: Context): Boolean = prefs(context).getBoolean(KEY_VERIFIED, false)

    /** True when the server can send a code and this phone has not proved its number yet. */
    fun needed(context: Context): Boolean =
        Registration.isRegistered(context) && prefs(context).getBoolean(KEY_AVAILABLE, false) && !isVerified(context)

    /** Keeps what the server said (registration answer or status check). */
    fun save(context: Context, answer: JSONObject) {
        prefs(context).edit()
            .putBoolean(KEY_VERIFIED, answer.optBoolean("number_verified", false))
            .putBoolean(KEY_AVAILABLE, answer.optBoolean("verification_available", false))
            .apply()
    }

    /** Background check, e.g. when Settings opens. Errors are ignored. */
    fun refresh(context: Context, then: (() -> Unit)? = null) {
        val app = context.applicationContext
        if (!Registration.isRegistered(app)) return
        Thread {
            runCatching { save(app, TraceApi.numberStatus()) }
            then?.let { Handler(Looper.getMainLooper()).post(it) }
        }.start()
    }

    /** Asks for the code when the server can send one and the number is not proved yet. */
    fun askIfNeeded(activity: Activity) {
        if (needed(activity)) ask(activity)
    }

    /** Sends a code to the registered number and shows where to type it. */
    fun ask(activity: Activity, onVerified: (() -> Unit)? = null) {
        val app = activity.applicationContext
        Toast.makeText(activity, R.string.verify_sending, Toast.LENGTH_SHORT).show()
        Thread {
            val error = try {
                TraceApi.sendNumberCode().let { answer -> if (answer.optBoolean("number_verified")) save(app, answer) }
                null
            } catch (e: Exception) {
                friendlyErrorMessage(e)
            }
            Handler(Looper.getMainLooper()).post {
                if (activity.isFinishing || activity.isDestroyed) return@post
                when {
                    isVerified(app) -> Toast.makeText(activity, R.string.verify_done, Toast.LENGTH_LONG).show()
                    error != null -> Toast.makeText(activity, activity.getString(R.string.verify_send_failed, error),
                        Toast.LENGTH_LONG).show()
                    else -> showCodeDialog(activity, onVerified)
                }
            }
        }.start()
    }

    private fun showCodeDialog(activity: Activity, onVerified: (() -> Unit)?) {
        val app = activity.applicationContext
        val pad = (20 * activity.resources.displayMetrics.density).toInt()
        val input = EditText(activity).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            hint = activity.getString(R.string.verify_hint)
        }
        val holder = FrameLayout(activity).apply {
            setPadding(pad, 0, pad, 0)
            addView(input)
        }
        val dialog = AlertDialog.Builder(activity)
            .setTitle(R.string.verify_title)
            .setMessage(activity.getString(R.string.verify_body, Registration.number(activity)))
            .setView(holder)
            .setPositiveButton(R.string.verify_confirm, null)
            .setNeutralButton(R.string.verify_resend, null)
            .setNegativeButton(R.string.reg_prompt_later, null)
            .create()
        dialog.setOnShowListener {
            // Set here, not in the builder, so a wrong code keeps the pop-up open.
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val code = input.text?.toString()?.filter { it.isDigit() }.orEmpty()
                if (code.length != 6) {
                    input.error = activity.getString(R.string.verify_need_code)
                    return@setOnClickListener
                }
                Thread {
                    val error = try {
                        save(app, TraceApi.confirmNumberCode(code))
                        null
                    } catch (e: TraceApi.ApiException) {
                        e.message ?: activity.getString(R.string.verify_wrong)
                    } catch (e: Exception) {
                        friendlyErrorMessage(e)
                    }
                    Handler(Looper.getMainLooper()).post {
                        if (error == null && isVerified(app)) {
                            dialog.dismiss()
                            Toast.makeText(activity, R.string.verify_done, Toast.LENGTH_LONG).show()
                            onVerified?.invoke()
                        } else {
                            input.error = error ?: activity.getString(R.string.verify_wrong)
                        }
                    }
                }.start()
            }
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                dialog.dismiss()
                ask(activity, onVerified)
            }
        }
        dialog.show()
    }
}

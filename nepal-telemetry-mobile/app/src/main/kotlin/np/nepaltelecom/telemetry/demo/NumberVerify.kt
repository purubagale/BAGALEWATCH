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
import np.nepaltelecom.telemetry.device.DeviceApi
import np.nepaltelecom.telemetry.device.NetDevice

/**
 * Proving the registered number by SMS code (2026-10-15). The number is
 * typed at registration, so on its own it proves nothing: someone could
 * type another person's number. When the server can send SMS, it says so in
 * its answer to registration; the app then asks for the code it sent to
 * that number. Until NTC's SMS gateway is set up the server says it cannot,
 * and nothing is asked.
 *
 * The state and the server calls are in the SDK ([NetDevice], since
 * 2026-10-16); the pop-ups are here.
 */
object NumberVerify {

    fun isVerified(context: Context): Boolean = NetDevice.isNumberVerified(context)

    /** True when the server can send a code and this phone has not proved its number yet. */
    fun needed(context: Context): Boolean = NetDevice.numberVerificationNeeded(context)

    /** Background check, e.g. when Settings opens. Errors are ignored. */
    fun refresh(context: Context, then: (() -> Unit)? = null) {
        val app = context.applicationContext
        if (!Registration.isRegistered(app)) return
        Thread {
            NetDevice.refreshNumberStatus(app)
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
                NetDevice.sendNumberCode(app)
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
                        NetDevice.confirmNumberCode(app, code)
                        null
                    } catch (e: DeviceApi.ApiException) {
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

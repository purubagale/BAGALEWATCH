package np.nepaltelecom.telemetry.demo

import android.text.InputType
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

/**
 * The pop-ups about registering this phone's number (2026-10-13): the one
 * that asks for it, after first-run setup or after an update, and the one
 * that says an updated app is already registered. Closing either leaves the
 * app usable; the form stays in Settings for a phone that is not registered.
 */
object RegisterPrompt {

    fun ask(activity: AppCompatActivity) {
        val pad = (20 * activity.resources.displayMetrics.density).toInt()
        val input = EditText(activity).apply {
            inputType = InputType.TYPE_CLASS_PHONE
            hint = activity.getString(R.string.req_hint)
            setText(Registration.number(activity))
        }
        val holder = FrameLayout(activity).apply {
            setPadding(pad, 0, pad, 0)
            addView(input)
        }
        val dialog = AlertDialog.Builder(activity)
            .setTitle(R.string.reg_prompt_title)
            .setMessage(R.string.reg_prompt_body)
            .setView(holder)
            .setPositiveButton(R.string.req_register, null)
            .setNegativeButton(R.string.reg_prompt_later, null)
            .create()
        dialog.setOnShowListener {
            // Set here, not in the builder, so an empty number keeps the pop-up open.
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val msisdn = input.text?.toString()?.trim().orEmpty()
                if (msisdn.isEmpty()) {
                    input.error = activity.getString(R.string.req_need_number)
                    return@setOnClickListener
                }
                dialog.dismiss()
                Toast.makeText(activity, R.string.req_registering, Toast.LENGTH_SHORT).show()
                Registration.register(activity, msisdn) { _, message ->
                    if (!activity.isFinishing && !activity.isDestroyed) {
                        Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
                        (activity as? MainActivity)?.onRegistrationChanged()
                    }
                }
            }
        }
        dialog.show()
    }

    fun alreadyRegistered(activity: AppCompatActivity) {
        AlertDialog.Builder(activity)
            .setTitle(R.string.reg_already_title)
            .setMessage(activity.getString(R.string.reg_already_body, Registration.number(activity)))
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }
}

package np.nepaltelecom.telemetry.demo

import android.graphics.drawable.GradientDrawable
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.text.method.DigitsKeyListener
import android.widget.EditText

/**
 * The mobile number field used for registration (2026-10-27): the pop-up
 * and the form in Settings. An NT mobile number is 10 digits (9XXXXXXXXX: 98, 97 and others);
 * no 977 or +977 is typed, the server adds the country code. The field takes
 * digits only, at most 10, and its border is grey while empty, red while the
 * number is incomplete and green at 10 digits. A pasted "+977 98..." keeps
 * its last 10 digits.
 */
object NumberField {

    const val DIGITS = 10

    private const val GREY = 0xFF9AA5B1.toInt()
    private const val RED = 0xFFD32F2F.toInt()
    private const val GREEN = 0xFF2E7D32.toInt()

    /** Sets up [field]; call once when the screen is built. */
    fun setUp(field: EditText) {
        field.inputType = InputType.TYPE_CLASS_PHONE
        field.keyListener = DigitsKeyListener.getInstance("0123456789")
        val density = field.resources.displayMetrics.density
        val pad = (12 * density).toInt()
        field.setPadding(pad, pad, pad, pad)
        field.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                val text = s?.toString().orEmpty()
                val clean = clean(text)
                if (clean != text) {
                    field.setText(clean)
                    field.setSelection(clean.length)
                    return // setText calls back here with the clean text
                }
                paint(field, clean)
            }
        })
        val clean = clean(field.text?.toString().orEmpty())
        if (clean != field.text?.toString()) field.setText(clean)
        paint(field, clean)
    }

    /** The number when it is exactly 10 digits, else null. */
    fun valid(field: EditText): String? =
        field.text?.toString()?.takeIf { it.length == DIGITS && it.all(Char::isDigit) }

    /** Digits only; a leading 977 from a pasted international number is dropped; at most 10. */
    private fun clean(text: String): String {
        var digits = text.filter(Char::isDigit)
        if (digits.length > DIGITS && digits.startsWith("977")) digits = digits.drop(3)
        return digits.take(DIGITS)
    }

    private fun paint(field: EditText, digits: String) {
        val density = field.resources.displayMetrics.density
        val color = when {
            digits.isEmpty() -> GREY
            digits.length == DIGITS -> GREEN
            else -> RED
        }
        field.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 8 * density
            setColor(0xFFFFFFFF.toInt())
            setStroke(((if (digits.isEmpty()) 1 else 2) * density).toInt().coerceAtLeast(1), color)
        }
    }
}

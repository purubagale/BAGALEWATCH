package np.nepaltelecom.telemetry.demo

import android.content.res.ColorStateList
import android.graphics.Color
import android.widget.Button
import com.google.android.material.button.MaterialButton
import java.util.WeakHashMap

/**
 * Colour feedback for buttons (2026-10-05). A button can be filled with a
 * colour while its action is active, then put back to the look its layout
 * gave it. Used on the Map drive buttons; any other button can use it too.
 */
object ButtonFeedback {
    /** Start, while a drive is running (the brand green, same as the signal scale). */
    const val GREEN = 0xFF16A34A.toInt()

    /** Stop, while a drive is running (the signal scale's red). */
    const val RED = 0xFFDC2626.toInt()

    private class Defaults(val tint: ColorStateList?, val text: ColorStateList, val stroke: ColorStateList?)

    /** Each button's own default colours, captured before its first change. */
    private val defaults = WeakHashMap<MaterialButton, Defaults>()

    /**
     * Fills the button with [fill] and makes its text white, or restores the
     * button's default colours when [fill] is null. A button that isn't a
     * MaterialButton is left as it is.
     */
    fun paint(button: Button, fill: Int?) {
        val mb = button as? MaterialButton ?: return
        val saved = defaults.getOrPut(mb) { Defaults(mb.backgroundTintList, mb.textColors, mb.strokeColor) }
        if (fill == null) {
            mb.backgroundTintList = saved.tint
            mb.setTextColor(saved.text)
            mb.strokeColor = saved.stroke
        } else {
            mb.backgroundTintList = ColorStateList.valueOf(fill)
            mb.setTextColor(Color.WHITE)
            mb.strokeColor = ColorStateList.valueOf(fill)
        }
    }
}
